import { createHash } from "node:crypto";
import type { ProductReviews } from "./schemas.js";

export function createReviewSentimentSourceHash(reviews: ProductReviews): string {
    return createHash("sha256")
        .update(
            JSON.stringify({
                overallRating: reviews.overallRating,
                totalCount: reviews.totalCount,
                items: reviews.items.map(review => ({
                    id: review.id,
                    rating: review.rating,
                    title: review.title,
                    comment: review.comment,
                    date: review.date,
                    verifiedPurchase: review.verifiedPurchase,
                    variant: review.variant,
                    helpfulCount: review.helpfulCount
                }))
            })
        )
        .digest("hex");
}
