import { createHash } from "node:crypto";
import type { ProductSuggestions, ScrapedProduct } from "./schemas.js";

export function createTranslationSourceHash(
    product: ScrapedProduct,
    suggestions: ProductSuggestions
): string {
    return createHash("sha256")
        .update(
            JSON.stringify({
                original: {
                    title: product.title,
                    productFeatures: product.productFeatures,
                    description: product.description
                },
                suggestions: {
                    title: suggestions.title.value,
                    productFeatures: suggestions.productFeatures.value,
                    description: suggestions.description.value
                },
                reviews: product.reviews.items.map(review => ({
                    id: review.id,
                    title: review.title,
                    comment: review.comment,
                    dateText: review.dateText,
                    variant: review.variant,
                    sourceLanguage: review.sourceLanguage
                }))
            })
        )
        .digest("hex");
}
