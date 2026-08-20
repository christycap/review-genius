import type { ZodError } from "zod";
import { createReviewKey } from "./review-key.js";
import {
    reviewSentimentAnalysisSchema,
    type ProductReviews,
    type ReviewSentimentAnalysis
} from "./schemas.js";

export class ReviewSentimentValidationError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Some chat models echo a small amount of supplied context even when the JSON
 * contract prohibits it. Remove only known, redundant input metadata; all
 * genuinely unexpected output remains subject to the strict Zod schema.
 */
function removeEchoedInputMetadata(value: unknown): unknown {
    if (!isRecord(value)) return value;

    const normalized = { ...value };
    for (const key of [
        "market",
        "overallRating",
        "totalReviewCount",
        "extractedReviewCount",
        "reviewCutoffDate"
    ]) {
        delete normalized[key];
    }

    if (Array.isArray(normalized.classifications)) {
        normalized.classifications = normalized.classifications.map(classification => {
            if (!isRecord(classification)) return classification;

            const normalizedClassification = { ...classification };
            for (const key of [
                "id",
                "rating",
                "title",
                "comment",
                "date",
                "verifiedPurchase",
                "variant",
                "helpfulCount"
            ]) {
                delete normalizedClassification[key];
            }
            return normalizedClassification;
        });
    }

    return normalized;
}

function formatZodError(error: ZodError): string {
    return error.issues
        .map(issue => `${issue.path.length === 0 ? "response" : issue.path.join(".")}: ${issue.message}`)
        .join("; ");
}

export function parseAndValidateReviewSentiment(
    content: string,
    reviews: ProductReviews,
    providerName: string
): ReviewSentimentAnalysis {
    let value: unknown;
    try {
        value = JSON.parse(content);
    } catch {
        throw new ReviewSentimentValidationError(
            `${providerName} returned review sentiment that was not valid JSON`
        );
    }

    const result = reviewSentimentAnalysisSchema.safeParse(removeEchoedInputMetadata(value));
    if (!result.success) {
        throw new ReviewSentimentValidationError(
            `${providerName} returned invalid review sentiment: ${formatZodError(result.error)}`
        );
    }

    if (result.data.classifications.length !== reviews.items.length) {
        throw new ReviewSentimentValidationError(
            `classifications has ${result.data.classifications.length} items; expected ${reviews.items.length}`
        );
    }

    reviews.items.forEach((review, index) => {
        const classification = result.data.classifications[index];
        if (
            classification.index !== index ||
            classification.reviewKey !== createReviewKey(review, index)
        ) {
            throw new ReviewSentimentValidationError(
                `classifications.${index} does not preserve its index or reviewKey`
            );
        }
    });

    return result.data;
}
