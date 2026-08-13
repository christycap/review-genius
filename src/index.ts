import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ZodError } from "zod";
import { fetchProduct } from "./amazon.js";
import { suggestProductImprovements } from "./deepseek.js";
import {
    inputSchema,
    storedOutputSchema,
    type Input,
    type StoredOutput,
    type StoredProduct
} from "./schemas.js";

const INPUT_DIRECTORY = path.resolve("input");
const OUTPUT_DIRECTORY = path.resolve("output");
const DATASET_FILENAME = "Smartbox_2026.json";

function formatZodError(error: ZodError): string {
    return error.issues
        .map(
            issue => `  - ${issue.path.length === 0 ? "input" : issue.path.join(".")}: ${issue.message}`
        )
        .join("\n");
}

async function readInput(filePath: string): Promise<Input> {
    let value: unknown;

    try {
        value = JSON.parse(await readFile(filePath, "utf8"));
    } catch (error) {
        if (error instanceof SyntaxError) {
            throw new Error(`Invalid JSON in ${filePath}: ${error.message}`);
        }
        throw error;
    }

    const result = inputSchema.safeParse(value);
    if (!result.success) {
        throw new Error(`Invalid input file ${filePath}:\n${formatZodError(result.error)}`);
    }

    return result.data;
}

async function readExistingOutput(filePath: string): Promise<StoredOutput> {
    try {
        const value: unknown = JSON.parse(await readFile(filePath, "utf8"));
        const result = storedOutputSchema.safeParse(value);

        if (!result.success) {
            throw new Error(`Existing output is malformed:\n${formatZodError(result.error)}`);
        }

        return result.data;
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return [];
        }
        throw error;
    }
}

async function writeOutput(filePath: string, output: StoredOutput): Promise<void> {
    await mkdir(OUTPUT_DIRECTORY, { recursive: true });
    await writeFile(filePath, `${JSON.stringify(output, null, 4)}\n`);
}

function hasLegacyReviewNoise(product: StoredProduct): boolean {
    return product.reviews.some(
        review =>
            review.comment.includes("Brief content visible, double tap to read full content.") ||
            review.comment.includes("Full content visible, double tap to read brief content.")
    );
}

function reconcileOutput(input: Input, existingOutput: StoredOutput): StoredOutput {
    return input.map(({ market, asins }) => {
        const existingMarket = existingOutput.find(output => output.market === market);

        return {
            market,
            products: asins.flatMap(asin => {
                const product = existingMarket?.products.find(product => product.asin === asin);
                return product === undefined ? [] : [product];
            })
        };
    });
}

async function processDataset(filename: string): Promise<string[]> {
    const inputPath = path.join(INPUT_DIRECTORY, filename);
    const outputPath = path.join(OUTPUT_DIRECTORY, filename);
    const input = await readInput(inputPath);
    const output = reconcileOutput(input, await readExistingOutput(outputPath));
    const errors: string[] = [];
    const asinCount = input.reduce((count, market) => count + market.asins.length, 0);

    console.log(`${filename}: ${input.length} market(s), ${asinCount} ASIN(s)`);

    for (const [marketIndex, { market, asins }] of input.entries()) {
        const marketOutput = output[marketIndex];
        console.log(`\n${market}: ${asins.length} ASIN(s)`);

        for (const [index, asin] of asins.entries()) {
            const existingIndex = marketOutput.products.findIndex(product => product.asin === asin);
            const existingProduct = marketOutput.products[existingIndex];
            const needsReviewCleanup =
                existingProduct !== undefined && hasLegacyReviewNoise(existingProduct);

            if (existingProduct?.suggestions !== undefined && !needsReviewCleanup) {
                console.log(`  [${index + 1}/${asins.length}] ${asin}: already complete`);
                continue;
            }

            try {
                let scrapedProduct = existingProduct;

                if (scrapedProduct === undefined || needsReviewCleanup) {
                    const action = needsReviewCleanup
                        ? "re-parsing product to clean reviews..."
                        : "fetching...";
                    console.log(`  [${index + 1}/${asins.length}] ${asin}: ${action}`);
                    scrapedProduct = await fetchProduct(market, asin);
                } else {
                    console.log(`  [${index + 1}/${asins.length}] ${asin}: using existing product data`);
                }

                console.log(`    Requesting DeepSeek suggestions...`);
                const suggestions = await suggestProductImprovements(market, scrapedProduct);
                const completedProduct: StoredProduct = { ...scrapedProduct, suggestions };

                if (existingIndex === -1) {
                    marketOutput.products.push(completedProduct);
                } else {
                    marketOutput.products[existingIndex] = completedProduct;
                }

                await writeOutput(outputPath, output);
                console.log(
                    `  [${index + 1}/${asins.length}] ${asin}: saved (${
                        scrapedProduct.reviews.length
                    } reviews)`
                );
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                errors.push(`${filename} / ${market} / ${asin}: ${message}`);
                console.error(`  [${index + 1}/${asins.length}] ${asin}: failed: ${message}`);
            }
        }
    }

    await writeOutput(outputPath, output);
    return errors;
}

async function main(): Promise<void> {
    const errors = await processDataset(DATASET_FILENAME);

    if (errors.length > 0) {
        throw new Error(
            `Completed with ${errors.length} failure(s):\n${errors
                .map(error => `  - ${error}`)
                .join("\n")}`
        );
    }

    console.log("\nDataset completed successfully.");
}

main().catch(error => {
    console.error(`\nBuild failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
});
