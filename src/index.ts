import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { ZodError } from "zod";
import { createSuggestionService, type SuggestionService } from "./ai.js";
import { closeAmazonBrowser } from "./amazon-browser.js";
import { isReviewCollectionCurrent } from "./amazon-reviews.js";
import { fetchProduct } from "./amazon.js";
import { withElapsedStatus } from "./console-progress.js";
import { DEEPSEEK_MODEL } from "./deepseek.js";
import { generateMarketExcelWorkbooks } from "./excel/generate-excel.js";
import { generateReport } from "./report/generate-report.js";
import { createReviewSentimentSourceHash } from "./review-sentiment-source.js";
import {
    SENTIMENT_PROMPT_VERSION,
    SUGGESTION_PROMPT_VERSION,
    TRANSLATION_PROMPT_VERSION,
    inputSchema,
    legacyStoredOutputSchema,
    legacyUnwrappedStoredOutputSchema,
    storedOutputSchema,
    type Input,
    type StoredOutput,
    type StoredProduct
} from "./schemas.js";
import { createTranslationSourceHash } from "./translation-source.js";

const INPUT_DIRECTORY = path.resolve("input");
const OUTPUT_DIRECTORY = path.resolve("output");
const DATASET_FILENAME = "Smartbox_2026.json";
const DATASET_TITLE = inferReportTitle(DATASET_FILENAME);
const DATASET_BASENAME = path.parse(DATASET_FILENAME).name;
const REPORT_OUTPUT_PATH = path.join(OUTPUT_DIRECTORY, `${DATASET_BASENAME}.html`);
const DATA_OUTPUT_PATH = path.join(OUTPUT_DIRECTORY, `${DATASET_BASENAME}.json`);
const LEGACY_REPORT_DIRECTORY = path.join(OUTPUT_DIRECTORY, DATASET_BASENAME);
const LEGACY_DATA_OUTPUT_PATH = path.join(LEGACY_REPORT_DIRECTORY, "assets/data.json");

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
                                items: product.reviews.map(review => ({ ...review, title: null })),
                                collection: {
                                    strategy: "embedded-top",
                                    limit: 30,
                                    collectedAt: null,
                                    pagesVisited: 0,
                                    complete: false,
                                    scraperVersion: 1,
                                    corpusHash: null
                                }
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

function hasCurrentSuggestions(product: StoredProduct, suggestionService: SuggestionService): boolean {
    if (
        product.suggestions === undefined ||
        product.suggestionPromptVersion !== SUGGESTION_PROMPT_VERSION
    ) {
        return false;
    }

    const cachedProvider = product.suggestionProvider ?? "deepseek";
    const cachedModel =
        product.suggestionModel ?? (cachedProvider === "deepseek" ? DEEPSEEK_MODEL : undefined);

    return cachedProvider === suggestionService.provider && cachedModel === suggestionService.model;
}

function hasCurrentReviewSentiment(
    product: StoredProduct,
    suggestionService: SuggestionService
): boolean {
    if (
        product.reviewSentiment === undefined ||
        product.sentimentPromptVersion !== SENTIMENT_PROMPT_VERSION ||
        product.sentimentProvider !== suggestionService.provider ||
        product.sentimentModel !== suggestionService.model
    ) {
        return false;
    }

    return product.sentimentSourceHash === createReviewSentimentSourceHash(product.reviews);
}

function hasCurrentTranslations(product: StoredProduct, suggestionService: SuggestionService): boolean {
    if (
        product.suggestions === undefined ||
        product.englishTranslations === undefined ||
        product.translationPromptVersion !== TRANSLATION_PROMPT_VERSION ||
        product.translationProvider !== suggestionService.provider ||
        product.translationModel !== suggestionService.model
    ) {
        return false;
    }

    return product.translationSourceHash === createTranslationSourceHash(product, product.suggestions);
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

async function processDataset(
    filename: string,
    suggestionService: SuggestionService
): Promise<{ errors: string[]; output: StoredOutput }> {
    const inputPath = path.join(INPUT_DIRECTORY, filename);
    const input = await readInput(inputPath);
    const existingOutput = await readExistingOutput();
    const output = reconcileOutput(input, existingOutput.output);
    const errors: string[] = [];
    const asinCount = input.reduce((count, market) => count + market.asins.length, 0);

    console.log(`${filename}: ${input.length} market(s), ${asinCount} ASIN(s)`);
    console.log(`AI provider: ${suggestionService.providerName} (${suggestionService.model})`);

    for (const [marketIndex, { market, asins }] of input.entries()) {
        const marketOutput = output.markets[marketIndex];
        console.log(`\n${market}: ${asins.length} ASIN(s)`);

        for (const [index, asin] of asins.entries()) {
            const existingIndex = marketOutput.products.findIndex(product => product.asin === asin);
            const existingProduct = marketOutput.products[existingIndex];
            const needsReviewRefresh =
                existingOutput.productsNeedingReviewRefresh.has(productKey(market, asin)) ||
                (existingProduct !== undefined &&
                    (hasLegacyReviewNoise(existingProduct) ||
                        !isReviewCollectionCurrent(existingProduct.reviews)));

            if (
                existingProduct !== undefined &&
                hasCurrentReviewSentiment(existingProduct, suggestionService) &&
                hasCurrentSuggestions(existingProduct, suggestionService) &&
                hasCurrentTranslations(existingProduct, suggestionService) &&
                !needsReviewRefresh
            ) {
                existingProduct.suggestionProvider = suggestionService.provider;
                existingProduct.suggestionModel = suggestionService.model;
                console.log(`  [${index + 1}/${asins.length}] ${asin}: already complete`);
                continue;
            }

            try {
                let scrapedProduct = existingProduct;
                let productOutputIndex = existingIndex;
                const setOutputProduct = (product: StoredProduct): void => {
                    if (productOutputIndex === -1) {
                        marketOutput.products.push(product);
                        productOutputIndex = marketOutput.products.length - 1;
                    } else {
                        marketOutput.products[productOutputIndex] = product;
                    }
                };

                if (scrapedProduct === undefined || needsReviewRefresh) {
                    const action = needsReviewRefresh
                        ? "re-parsing product to refresh review data..."
                        : "fetching...";
                    console.log(`  [${index + 1}/${asins.length}] ${asin}: ${action}`);
                    scrapedProduct = await fetchProduct(market, asin);
                } else {
                    console.log(`  [${index + 1}/${asins.length}] ${asin}: using existing product data`);
                }

                const scrapedOnlyProduct: StoredProduct = {
                    asin: scrapedProduct.asin,
                    title: scrapedProduct.title,
                    productFeatures: scrapedProduct.productFeatures,
                    description: scrapedProduct.description,
                    productImageUrl: scrapedProduct.productImageUrl,
                    reviews: scrapedProduct.reviews
                };
                const sentimentSourceHash = createReviewSentimentSourceHash(scrapedProduct.reviews);
                const canReuseReviewSentiment =
                    existingProduct !== undefined &&
                    hasCurrentReviewSentiment(existingProduct, suggestionService) &&
                    existingProduct.sentimentSourceHash === sentimentSourceHash;
                const reviewSentiment = canReuseReviewSentiment
                    ? existingProduct.reviewSentiment!
                    : await (async () => {
                          setOutputProduct(scrapedOnlyProduct);
                          await writeOutput(DATA_OUTPUT_PATH, output);
                          return withElapsedStatus(
                              `    Requesting ${suggestionService.providerName} review sentiment analysis...`,
                              () => suggestionService.analyzeReviews(market, scrapedProduct.reviews)
                          );
                      })();

                if (canReuseReviewSentiment) {
                    console.log(
                        "    Review evidence is unchanged; keeping the existing sentiment analysis"
                    );
                }

                const analyzedProduct: StoredProduct & {
                    reviewSentiment: NonNullable<StoredProduct["reviewSentiment"]>;
                } = {
                    ...scrapedOnlyProduct,
                    reviewSentiment,
                    sentimentPromptVersion: SENTIMENT_PROMPT_VERSION,
                    sentimentProvider: suggestionService.provider,
                    sentimentModel: suggestionService.model,
                    sentimentSourceHash
                };
                setOutputProduct(analyzedProduct);

                const canReuseSuggestions =
                    existingProduct !== undefined &&
                    canReuseReviewSentiment &&
                    hasCurrentSuggestions(existingProduct, suggestionService) &&
                    existingProduct.reviews.collection.corpusHash !== null &&
                    existingProduct.reviews.collection.corpusHash ===
                        scrapedProduct.reviews.collection.corpusHash;
                const suggestions = canReuseSuggestions
                    ? existingProduct.suggestions!
                    : await (async () => {
                          await writeOutput(DATA_OUTPUT_PATH, output);
                          return withElapsedStatus(
                              `    Requesting ${suggestionService.providerName} suggestions...`,
                              () => suggestionService.suggest(market, analyzedProduct)
                          );
                      })();

                if (canReuseSuggestions) {
                    console.log("    Review corpus is unchanged; keeping the existing suggestions");
                }

                const translationSourceHash = createTranslationSourceHash(analyzedProduct, suggestions);
                const canReuseTranslations =
                    existingProduct !== undefined &&
                    existingProduct.englishTranslations !== undefined &&
                    existingProduct.translationPromptVersion === TRANSLATION_PROMPT_VERSION &&
                    existingProduct.translationProvider === suggestionService.provider &&
                    existingProduct.translationModel === suggestionService.model &&
                    existingProduct.translationSourceHash === translationSourceHash;
                const suggestionProduct: StoredProduct = {
                    ...analyzedProduct,
                    suggestions,
                    suggestionPromptVersion: SUGGESTION_PROMPT_VERSION,
                    suggestionProvider: suggestionService.provider,
                    suggestionModel: suggestionService.model
                };

                setOutputProduct(suggestionProduct);

                let completedProduct: StoredProduct;
                if (canReuseTranslations) {
                    console.log(
                        "    Source copy is unchanged; keeping the existing English translations"
                    );
                    completedProduct = {
                        ...suggestionProduct,
                        englishTranslations: existingProduct.englishTranslations!,
                        translationPromptVersion: TRANSLATION_PROMPT_VERSION,
                        translationProvider: suggestionService.provider,
                        translationModel: suggestionService.model,
                        translationSourceHash
                    };
                } else {
                    // Persist expensive suggestions before the separate translation request so a
                    // transient translation failure can resume without asking the model to rewrite.
                    await writeOutput(DATA_OUTPUT_PATH, output);
                    const englishTranslations = await withElapsedStatus(
                        `    Requesting ${suggestionService.providerName} English translations...`,
                        () => suggestionService.translate(market, analyzedProduct, suggestions)
                    );
                    completedProduct = {
                        ...suggestionProduct,
                        englishTranslations,
                        translationPromptVersion: TRANSLATION_PROMPT_VERSION,
                        translationProvider: suggestionService.provider,
                        translationModel: suggestionService.model,
                        translationSourceHash
                    };
                }

                setOutputProduct(completedProduct);

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
    const suggestionService = createSuggestionService();
    let result: Awaited<ReturnType<typeof processDataset>>;

    try {
        result = await processDataset(DATASET_FILENAME, suggestionService);
    } finally {
        await closeAmazonBrowser();
    }

    const { errors, output } = result;
    console.log("\nGenerating self-contained HTML report...");
    await generateReport(output, REPORT_OUTPUT_PATH, suggestionService.reportConfig);
    console.log("Generating per-market Excel workbooks...");
    const excelOutputPaths = await generateMarketExcelWorkbooks(
        output,
        OUTPUT_DIRECTORY,
        DATASET_BASENAME
    );
    await Promise.all([
        rm(LEGACY_REPORT_DIRECTORY, { recursive: true, force: true }),
        rm(path.join(OUTPUT_DIRECTORY, ".DS_Store"), { force: true })
    ]);
    console.log(`Report generated at ${REPORT_OUTPUT_PATH}`);
    console.log(`Raw data saved at ${DATA_OUTPUT_PATH}`);
    excelOutputPaths.forEach(excelOutputPath => {
        console.log(`Excel export generated at ${excelOutputPath}`);
    });

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
