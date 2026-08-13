import { z } from "zod";

const asinSchema = z
    .string()
    .regex(/^[A-Z0-9]{10}$/, "must be a 10-character Amazon ASIN using A-Z and 0-9");

export const marketSchema = z.enum(["fr", "it", "es"], {
    error: "must be one of: fr, it, es"
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

export const reviewSchema = z.object({
    rating: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
    comment: z.string()
});

export const scrapedProductSchema = z.object({
    asin: asinSchema,
    title: z.string(),
    productFeatures: z.array(z.string()),
    description: z.string(),
    productImageUrl: z.string(),
    reviews: z.array(reviewSchema)
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

export const storedProductSchema = scrapedProductSchema.extend({
    suggestions: suggestionsSchema.optional()
});

export const productSchema = scrapedProductSchema.extend({
    suggestions: suggestionsSchema
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

export const storedOutputSchema = z
    .array(storedMarketOutputSchema)
    .superRefine(rejectDuplicateOutputMarkets);
export const outputSchema = z.array(marketOutputSchema).superRefine(rejectDuplicateOutputMarkets);

export type Input = z.infer<typeof inputSchema>;
export type Market = z.infer<typeof marketSchema>;
export type ScrapedProduct = z.infer<typeof scrapedProductSchema>;
export type ProductSuggestions = z.infer<typeof suggestionsSchema>;
export type StoredProduct = z.infer<typeof storedProductSchema>;
export type StoredOutput = z.infer<typeof storedOutputSchema>;
export type OutputProduct = z.infer<typeof productSchema>;
