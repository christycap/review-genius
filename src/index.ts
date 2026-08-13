import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ZodError } from "zod";
import { fetchProduct } from "./amazon.js";
import { suggestProductImprovements } from "./deepseek.js";
import { inputSchema, storedOutputSchema, type Input, type StoredProduct } from "./schemas.js";

const INPUT_DIRECTORY = path.resolve("input");
const OUTPUT_DIRECTORY = path.resolve("output");

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

async function readExistingOutput(filePath: string): Promise<StoredProduct[]> {
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

async function writeOutput(filePath: string, products: StoredProduct[]): Promise<void> {
    await mkdir(OUTPUT_DIRECTORY, { recursive: true });
    await writeFile(filePath, `${JSON.stringify(products, null, 4)}\n`);
}

function hasLegacyReviewNoise(product: StoredProduct): boolean {
    return product.reviews.some(
        review =>
            review.comment.includes("Brief content visible, double tap to read full content.") ||
            review.comment.includes("Full content visible, double tap to read brief content.")
    );
}

async function processInputFile(filename: string): Promise<string[]> {
    const inputPath = path.join(INPUT_DIRECTORY, filename);
    const outputPath = path.join(OUTPUT_DIRECTORY, filename);
    const input = await readInput(inputPath);
    const products = await readExistingOutput(outputPath);
    const errors: string[] = [];

    console.log(`\n${filename}: ${input.asins.length} ASIN(s), market=${input.market}`);

    for (const [index, asin] of input.asins.entries()) {
        const existingIndex = products.findIndex(product => product.asin === asin);
        const existingProduct = products[existingIndex];
        const needsReviewCleanup =
            existingProduct !== undefined && hasLegacyReviewNoise(existingProduct);

        if (existingProduct?.suggestions !== undefined && !needsReviewCleanup) {
            console.log(`  [${index + 1}/${input.asins.length}] ${asin}: already complete`);
            continue;
        }

        try {
            let scrapedProduct = existingProduct;

            if (scrapedProduct === undefined || needsReviewCleanup) {
                const action = needsReviewCleanup
                    ? "re-parsing product to clean reviews..."
                    : "fetching...";
                console.log(`  [${index + 1}/${input.asins.length}] ${asin}: ${action}`);
                scrapedProduct = await fetchProduct(input.market, asin);
            } else {
                console.log(
                    `  [${index + 1}/${input.asins.length}] ${asin}: using existing product data`
                );
            }

            console.log(`    Requesting DeepSeek suggestions...`);
            const suggestions = await suggestProductImprovements(input.market, scrapedProduct);
            const completedProduct: StoredProduct = { ...scrapedProduct, suggestions };

            if (existingIndex === -1) {
                products.push(completedProduct);
            } else {
                products[existingIndex] = completedProduct;
            }

            await writeOutput(outputPath, products);
            console.log(
                `  [${index + 1}/${input.asins.length}] ${asin}: saved (${
                    scrapedProduct.reviews.length
                } reviews)`
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            errors.push(`${filename} / ${asin}: ${message}`);
            console.error(`  [${index + 1}/${input.asins.length}] ${asin}: failed: ${message}`);
        }
    }

    return errors;
}

async function main(): Promise<void> {
    const entries = await readdir(INPUT_DIRECTORY, { withFileTypes: true });
    const filenames = entries
        .filter(entry => entry.isFile() && path.extname(entry.name) === ".json")
        .map(entry => entry.name)
        .sort();

    if (filenames.length === 0) {
        throw new Error(`No .json input files found in ${INPUT_DIRECTORY}`);
    }

    console.log(`Found ${filenames.length} input file(s): ${filenames.join(", ")}`);
    const errors: string[] = [];

    for (const filename of filenames) {
        errors.push(...(await processInputFile(filename)));
    }

    if (errors.length > 0) {
        throw new Error(
            `Completed with ${errors.length} failure(s):\n${errors
                .map(error => `  - ${error}`)
                .join("\n")}`
        );
    }

    console.log("\nAll input files completed successfully.");
}

main().catch(error => {
    console.error(`\nBuild failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
});
