import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ZodError } from "zod";
import { fetchProduct } from "./amazon.js";
import { suggestProductImprovements } from "./deepseek.js";
import { generateReport } from "./report/generate-report.js";
import {
    SUGGESTION_PROMPT_VERSION,
    inputSchema,
    legacyStoredOutputSchema,
    legacyUnwrappedStoredOutputSchema,
    storedOutputSchema,
    type Input,
    type StoredOutput,
    type StoredProduct
} from "./schemas.js";

const INPUT_DIRECTORY = path.resolve("input");
const OUTPUT_DIRECTORY = path.resolve("output");
const DATASET_FILENAME = "Smartbox_2026.json";
const DATASET_TITLE = inferReportTitle(DATASET_FILENAME);
const REPORT_DIRECTORY = path.join(OUTPUT_DIRECTORY, path.parse(DATASET_FILENAME).name);
const DATA_OUTPUT_PATH = path.join(REPORT_DIRECTORY, "assets/data.json");
const LEGACY_DATA_OUTPUT_PATH = path.join(OUTPUT_DIRECTORY, DATASET_FILENAME);

type ExistingOutput = {
    output: StoredOutput;
    productsNeedingReviewRefresh: Set<string>;
};

function inferReportTitle(filename: string): string {
    const title = path.parse(filename).name.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();

    if (title.length === 0) {
        throw new Error(`Could not infer a report title from dataset filename: ${filename}`);
    }

    return title;
}

function productKey(market: string, asin: string): string {
    return `${market}/${asin}`;
}

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

async function readOutputFile(filePath: string): Promise<ExistingOutput | undefined> {
    try {
        const value: unknown = JSON.parse(await readFile(filePath, "utf8"));
        const result = storedOutputSchema.safeParse(value);

        if (result.success) {
            return {
                output: result.data,
                productsNeedingReviewRefresh: new Set()
            };
        }

        const unwrappedResult = legacyUnwrappedStoredOutputSchema.safeParse(value);
        if (unwrappedResult.success) {
            return {
                output: {
                    title: DATASET_TITLE,
                    markets: unwrappedResult.data
                },
                productsNeedingReviewRefresh: new Set()
            };
        }

        const legacyResult = legacyStoredOutputSchema.safeParse(value);
        if (legacyResult.success) {
            const productsNeedingReviewRefresh = new Set<string>();
            const output: StoredOutput = {
                title: DATASET_TITLE,
                markets: legacyResult.data.map(group => ({
                    market: group.market,
                    products: group.products.map(product => {
                        productsNeedingReviewRefresh.add(productKey(group.market, product.asin));

                        return {
                            ...product,
                            reviews: {
                                overallRating: 0,
                                totalCount: 0,
                                items: product.reviews.map(review => ({ ...review, title: null }))
                            }
                        };
                    })
                }))
            };

            return { output, productsNeedingReviewRefresh };
        }

        throw new Error(`Existing output is malformed:\n${formatZodError(result.error)}`);
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return undefined;
        }
        throw error;
    }
}

async function readExistingOutput(): Promise<ExistingOutput> {
    return (
        (await readOutputFile(DATA_OUTPUT_PATH)) ??
        (await readOutputFile(LEGACY_DATA_OUTPUT_PATH)) ?? {
            output: { title: DATASET_TITLE, markets: [] },
            productsNeedingReviewRefresh: new Set()
        }
    );
}

async function writeOutput(filePath: string, output: StoredOutput): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(output, null, 4)}\n`);
}

function hasLegacyReviewNoise(product: StoredProduct): boolean {
    return product.reviews.items.some(
        review =>
            review.comment.includes("Brief content visible, double tap to read full content.") ||
            review.comment.includes("Full content visible, double tap to read brief content.")
    );
}

function reconcileOutput(input: Input, existingOutput: StoredOutput): StoredOutput {
    return {
        title: DATASET_TITLE,
        markets: input.map(({ market, asins }) => {
            const existingMarket = existingOutput.markets.find(output => output.market === market);

            return {
                market,
                products: asins.flatMap(asin => {
                    const product = existingMarket?.products.find(product => product.asin === asin);
                    return product === undefined ? [] : [product];
                })
            };
        })
    };
}

async function processDataset(filename: string): Promise<{ errors: string[]; output: StoredOutput }> {
    const inputPath = path.join(INPUT_DIRECTORY, filename);
    const input = await readInput(inputPath);
    const existingOutput = await readExistingOutput();
    const output = reconcileOutput(input, existingOutput.output);
    const errors: string[] = [];
    const asinCount = input.reduce((count, market) => count + market.asins.length, 0);

    console.log(`${filename}: ${input.length} market(s), ${asinCount} ASIN(s)`);

    for (const [marketIndex, { market, asins }] of input.entries()) {
        const marketOutput = output.markets[marketIndex];
        console.log(`\n${market}: ${asins.length} ASIN(s)`);

        for (const [index, asin] of asins.entries()) {
            const existingIndex = marketOutput.products.findIndex(product => product.asin === asin);
            const existingProduct = marketOutput.products[existingIndex];
            const needsReviewRefresh =
                existingOutput.productsNeedingReviewRefresh.has(productKey(market, asin)) ||
                (existingProduct !== undefined && hasLegacyReviewNoise(existingProduct));

            if (
                existingProduct?.suggestions !== undefined &&
                existingProduct.suggestionPromptVersion === SUGGESTION_PROMPT_VERSION &&
                !needsReviewRefresh
            ) {
                console.log(`  [${index + 1}/${asins.length}] ${asin}: already complete`);
                continue;
            }

            try {
                let scrapedProduct = existingProduct;

                if (scrapedProduct === undefined || needsReviewRefresh) {
                    const action = needsReviewRefresh
                        ? "re-parsing product to refresh review data..."
                        : "fetching...";
                    console.log(`  [${index + 1}/${asins.length}] ${asin}: ${action}`);
                    scrapedProduct = await fetchProduct(market, asin);
                } else {
                    console.log(`  [${index + 1}/${asins.length}] ${asin}: using existing product data`);
                }

                console.log(`    Requesting DeepSeek suggestions...`);
                const suggestions = await suggestProductImprovements(market, scrapedProduct);
                const completedProduct: StoredProduct = {
                    ...scrapedProduct,
                    suggestions,
                    suggestionPromptVersion: SUGGESTION_PROMPT_VERSION
                };

                if (existingIndex === -1) {
                    marketOutput.products.push(completedProduct);
                } else {
                    marketOutput.products[existingIndex] = completedProduct;
                }

                await writeOutput(DATA_OUTPUT_PATH, output);
                console.log(
                    `  [${index + 1}/${asins.length}] ${asin}: saved (${
                        scrapedProduct.reviews.items.length
                    } extracted reviews, ${scrapedProduct.reviews.totalCount} total)`
                );
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                errors.push(`${filename} / ${market} / ${asin}: ${message}`);
                console.error(`  [${index + 1}/${asins.length}] ${asin}: failed: ${message}`);
            }
        }
    }

    await writeOutput(DATA_OUTPUT_PATH, output);
    return { errors, output };
}

async function main(): Promise<void> {
    const { errors, output } = await processDataset(DATASET_FILENAME);
    console.log("\nGenerating self-contained HTML report...");
    await generateReport(output, REPORT_DIRECTORY);
    console.log(`Report generated at ${path.join(REPORT_DIRECTORY, "index.html")}`);

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
