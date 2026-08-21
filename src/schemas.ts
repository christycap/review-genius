import { z } from "zod";
import { PRODUCT_TRANSLATION_PROMPT_VERSION } from "./prompts/english-translation.js";
import { PRODUCT_OPTIMIZATION_PROMPT_VERSION } from "./prompts/product-optimization.js";
import { REVIEW_SENTIMENT_PROMPT_VERSION } from "./prompts/review-sentiment.js";
import { LEGACY_REVIEW_STORAGE_LIMIT } from "./review-constants.js";

export const SUGGESTION_PROMPT_VERSION = PRODUCT_OPTIMIZATION_PROMPT_VERSION;
export const TRANSLATION_PROMPT_VERSION = PRODUCT_TRANSLATION_PROMPT_VERSION;
export const SENTIMENT_PROMPT_VERSION = REVIEW_SENTIMENT_PROMPT_VERSION;

const asinSchema = z
    .string()
    .regex(/^[A-Z0-9]{10}$/, "must be a 10-character Amazon ASIN using A-Z and 0-9");

export const marketSchema = z.enum(["fr", "it", "es", "de", "be", "nl"], {
    error: "must be one of: fr, it, es, de, be, nl"
});

const marketInputSchema = z
    .object({
        market: marketSchema,
        asins: z.array(asinSchema).min(1, "must contain at least one ASIN")
    })
    .strict()
    .superRefine(({ asins }, context) => {
        const seen = new Set<string>();

        asins.forEach((asin, index) => {
            if (seen.has(asin)) {
                context.addIssue({
                    code: "custom",
                    path: ["asins", index],
                    message: `duplicate ASIN: ${asin}`
                });
            }

            seen.add(asin);
        });
    });

export const inputSchema = z
    .array(marketInputSchema)
    .min(1, "must contain at least one market")
    .superRefine((markets, context) => {
        const seen = new Set<string>();

        markets.forEach(({ market }, index) => {
            if (seen.has(market)) {
                context.addIssue({
                    code: "custom",
                    path: [index, "market"],
                    message: `duplicate market: ${market}`
                });
            }

            seen.add(market);
        });
    });

export const reviewSelectionReasonSchema = z.enum(["embedded-top", "recent", "critical"]);

export const reviewSchema = z
    .object({
        id: z.string().min(1).nullable().default(null),
        rating: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
        title: z.string().nullable(),
        comment: z.string(),
        date: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .nullable()
            .default(null),
        dateText: z.string().default(""),
        verifiedPurchase: z.boolean().default(false),
        reviewedAsin: asinSchema.nullable().default(null),
        variant: z.string().nullable().default(null),
        sourceLanguage: z.string().min(1).nullable().default(null),
        helpfulCount: z.number().int().nonnegative().default(0),
        selectionReason: reviewSelectionReasonSchema.default("embedded-top")
    })
    .strict();

export const reviewCollectionSchema = z.preprocess(
    value => {
        if (typeof value !== "object" || value === null || Array.isArray(value)) return value;

        // Backward compatibility for reports produced while an age cutoff was enforced.
        const { reviewCutoffDate: _legacyReviewCutoffDate, ...collection } = value as Record<
            string,
            unknown
        >;
        return collection;
    },
    z
        .object({
            strategy: z.enum(["embedded-top", "recent", "recent-balanced"]),
            // Accept the former ceiling so existing output can be loaded and refreshed.
            limit: z.number().int().min(1).max(LEGACY_REVIEW_STORAGE_LIMIT),
            collectedAt: z.string().datetime().nullable(),
            pagesVisited: z.number().int().nonnegative(),
            complete: z.boolean(),
            scraperVersion: z.number().int().positive(),
            corpusHash: z
                .string()
                .regex(/^[a-f0-9]{64}$/)
                .nullable()
        })
        .strict()
);

const legacyReviewCollection = {
    strategy: "embedded-top" as const,
    limit: 30,
    collectedAt: null,
    pagesVisited: 0,
    complete: false,
    scraperVersion: 1,
    corpusHash: null
};

export const productReviewsSchema = z
    .object({
        overallRating: z.number().min(0).max(5),
        totalCount: z.number().int().nonnegative(),
        // Scraper v6 writes at most 70; the larger bound is read compatibility for v5 output.
        items: z.array(reviewSchema).max(LEGACY_REVIEW_STORAGE_LIMIT),
        collection: reviewCollectionSchema.default(legacyReviewCollection)
    })
    .strict();

export const scrapedProductSchema = z.object({
    asin: asinSchema,
    title: z.string(),
    productFeatures: z.array(z.string()),
    description: z.string(),
    productImageUrl: z.string(),
    reviews: productReviewsSchema
});

const stringSuggestionSchema = z
    .object({
        value: z.string().min(1, "must not be empty"),
        reasoning: z.string().min(1, "must not be empty")
    })
    .strict();

const productFeaturesSuggestionSchema = z
    .object({
        value: z
            .array(z.string().min(1, "must not be empty"))
            .min(1, "must contain at least one feature"),
        reasoning: z.string().min(1, "must not be empty")
    })
    .strict();

export const suggestionsSchema = z
    .object({
        title: stringSuggestionSchema,
        productFeatures: productFeaturesSuggestionSchema,
        description: stringSuggestionSchema
    })
    .strict();

export const suggestionProviderSchema = z.enum(["deepseek", "gemini"]);

export const reviewSentimentSchema = z.enum(["positive", "negative"]);

export const reviewSentimentAnalysisSchema = z
    .object({
        overallSummary: z.string().trim().min(1),
        positiveSummary: z.string().trim().min(1),
        negativeSummary: z.string().trim().min(1),
        classifications: z.array(
            z
                .object({
                    index: z.number().int().nonnegative(),
                    reviewKey: z.string().min(1),
                    sentiment: reviewSentimentSchema
                })
                .strict()
        )
    })
    .strict();

export const listingEnglishTranslationsSchema = z
    .object({
        title: z.string(),
        productFeatures: z.array(z.string()),
        description: z.string()
    })
    .strict();

export const reviewEnglishTranslationSchema = z
    .object({
        index: z.number().int().nonnegative(),
        reviewKey: z.string().min(1),
        title: z.string(),
        comment: z.string(),
        dateText: z.string(),
        variant: z.string()
    })
    .strict();

export const productEnglishTranslationsSchema = z
    .object({
        original: listingEnglishTranslationsSchema,
        suggestions: listingEnglishTranslationsSchema,
        reviews: z.array(reviewEnglishTranslationSchema)
    })
    .strict();

export const refinedSuggestionsSchema = z
    .object({
        suggestions: suggestionsSchema,
        englishTranslations: listingEnglishTranslationsSchema
    })
    .strict();

export const storedProductSchema = scrapedProductSchema.extend({
    suggestions: suggestionsSchema.optional(),
    suggestionPromptVersion: z.number().int().positive().optional(),
    suggestionProvider: suggestionProviderSchema.optional(),
    suggestionModel: z.string().min(1).optional(),
    reviewSentiment: reviewSentimentAnalysisSchema.optional(),
    sentimentPromptVersion: z.number().int().positive().optional(),
    sentimentProvider: suggestionProviderSchema.optional(),
    sentimentModel: z.string().min(1).optional(),
    sentimentSourceHash: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    englishTranslations: productEnglishTranslationsSchema.optional(),
    translationPromptVersion: z.number().int().positive().optional(),
    translationProvider: suggestionProviderSchema.optional(),
    translationModel: z.string().min(1).optional(),
    translationSourceHash: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional()
});

export const productSchema = scrapedProductSchema.extend({
    suggestions: suggestionsSchema,
    suggestionPromptVersion: z.literal(SUGGESTION_PROMPT_VERSION),
    suggestionProvider: suggestionProviderSchema,
    suggestionModel: z.string().min(1),
    reviewSentiment: reviewSentimentAnalysisSchema,
    sentimentPromptVersion: z.literal(SENTIMENT_PROMPT_VERSION),
    sentimentProvider: suggestionProviderSchema,
    sentimentModel: z.string().min(1),
    sentimentSourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    englishTranslations: productEnglishTranslationsSchema,
    translationPromptVersion: z.literal(TRANSLATION_PROMPT_VERSION),
    translationProvider: suggestionProviderSchema,
    translationModel: z.string().min(1),
    translationSourceHash: z.string().regex(/^[a-f0-9]{64}$/)
});

const storedMarketOutputSchema = z
    .object({
        market: marketSchema,
        products: z.array(storedProductSchema)
    })
    .strict();

const marketOutputSchema = z
    .object({
        market: marketSchema,
        products: z.array(productSchema)
    })
    .strict();

function rejectDuplicateOutputMarkets(markets: { market: string }[], context: z.RefinementCtx): void {
    const seen = new Set<string>();

    markets.forEach(({ market }, index) => {
        if (seen.has(market)) {
            context.addIssue({
                code: "custom",
                path: [index, "market"],
                message: `duplicate market: ${market}`
            });
        }

        seen.add(market);
    });
}

export const legacyUnwrappedStoredOutputSchema = z
    .array(storedMarketOutputSchema)
    .superRefine(rejectDuplicateOutputMarkets);

const reportTitleSchema = z.string().trim().min(1, "must not be empty");

export const storedOutputSchema = z
    .object({
        title: reportTitleSchema,
        markets: legacyUnwrappedStoredOutputSchema
    })
    .strict();

export const outputSchema = z
    .object({
        title: reportTitleSchema,
        markets: z.array(marketOutputSchema).superRefine(rejectDuplicateOutputMarkets)
    })
    .strict();

const legacyReviewSchema = reviewSchema.omit({ title: true });
const legacyStoredProductSchema = scrapedProductSchema.omit({ reviews: true }).extend({
    reviews: z.array(legacyReviewSchema),
    suggestions: suggestionsSchema.optional(),
    suggestionPromptVersion: z.number().int().positive().optional(),
    suggestionProvider: suggestionProviderSchema.optional(),
    suggestionModel: z.string().min(1).optional()
});
const legacyStoredMarketOutputSchema = z
    .object({
        market: marketSchema,
        products: z.array(legacyStoredProductSchema)
    })
    .strict();

export const legacyStoredOutputSchema = z
    .array(legacyStoredMarketOutputSchema)
    .superRefine(rejectDuplicateOutputMarkets);

export type Input = z.infer<typeof inputSchema>;
export type Market = z.infer<typeof marketSchema>;
export type ScrapedProduct = z.infer<typeof scrapedProductSchema>;
export type ProductReviews = z.infer<typeof productReviewsSchema>;
export type Review = z.infer<typeof reviewSchema>;
export type ProductSuggestions = z.infer<typeof suggestionsSchema>;
export type ReviewSentiment = z.infer<typeof reviewSentimentSchema>;
export type ReviewSentimentAnalysis = z.infer<typeof reviewSentimentAnalysisSchema>;
export type ProductOptimizationProduct = ScrapedProduct & {
    reviewSentiment: ReviewSentimentAnalysis;
};
export type ListingEnglishTranslations = z.infer<typeof listingEnglishTranslationsSchema>;
export type ProductEnglishTranslations = z.infer<typeof productEnglishTranslationsSchema>;
export type RefinedSuggestions = z.infer<typeof refinedSuggestionsSchema>;
export type SuggestionProvider = z.infer<typeof suggestionProviderSchema>;
export type StoredProduct = z.infer<typeof storedProductSchema>;
export type StoredOutput = z.infer<typeof storedOutputSchema>;
export type OutputProduct = z.infer<typeof productSchema>;
