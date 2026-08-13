import { z } from "zod";

const asinSchema = z
    .string()
    .regex(/^[A-Z0-9]{10}$/, "must be a 10-character Amazon ASIN using A-Z and 0-9");

export const inputSchema = z
    .object({
        market: z.enum(["fr", "it", "es"], {
            error: "must be one of: fr, it, es"
        }),
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

export const reviewSchema = z.object({
    rating: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
    comment: z.string()
});

export const productSchema = z.object({
    asin: asinSchema,
    title: z.string(),
    productFeatures: z.array(z.string()),
    description: z.string(),
    productImageUrl: z.string(),
    reviews: z.array(reviewSchema).max(20)
});

export const outputSchema = z.array(productSchema);

export type Input = z.infer<typeof inputSchema>;
export type OutputProduct = z.infer<typeof productSchema>;
