import { AMAZON_REVIEW_LIMIT } from "../review-constants.js";

/**
 * Review sentiment is versioned independently from listing optimization and
 * translation so each AI artifact can be refreshed only when its own contract changes.
 */
export const REVIEW_SENTIMENT_PROMPT_VERSION = 3 as const;

export const REVIEW_SENTIMENT_JSON_SCHEMA = {
    type: "object",
    properties: {
        overallSummary: {
            type: "string",
            description:
                "An English synthesis reconciling Amazon's aggregate rating/count with the extracted qualitative review corpus."
        },
        positiveSummary: {
            type: "string",
            description:
                "An English synthesis of positive themes, weighted by helpful votes without overstating prevalence."
        },
        negativeSummary: {
            type: "string",
            description:
                "An English synthesis of negative themes and objections, weighted by helpful votes without overstating prevalence."
        },
        classifications: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    index: { type: "integer" },
                    reviewKey: { type: "string" },
                    sentiment: { type: "string", enum: ["positive", "negative"] }
                },
                required: ["index", "reviewKey", "sentiment"],
                additionalProperties: false
            }
        }
    },
    required: ["overallSummary", "positiveSummary", "negativeSummary", "classifications"],
    additionalProperties: false
} as const;

type ReviewSentimentContext = {
    overallRating: number;
    totalCount: number;
    items: {
        id: string | null;
        rating: number;
        title: string | null;
        comment: string;
        date: string | null;
        verifiedPurchase: boolean;
        variant: string | null;
        helpfulCount: number;
    }[];
};

export const REVIEW_SENTIMENT_SYSTEM_PROMPT = `You are a customer-review research analyst supporting Amazon listing optimization. Classify every supplied extracted review by its dominant purchase sentiment and produce concise English summaries that accurately distinguish population-level evidence from qualitative review themes.

Return only one JSON object with exactly this shape:
{
    "overallSummary": "English overall sentiment synthesis",
    "positiveSummary": "English positive-theme synthesis",
    "negativeSummary": "English negative-theme synthesis",
    "classifications": [
        {
            "index": 0,
            "reviewKey": "identifier copied exactly from the input",
            "sentiment": "positive"
        }
    ]
}

Rules:
- Classify every extracted review exactly once as either positive or negative. There is no neutral label. Use the review's dominant purchase implication; for genuinely balanced or ambiguous text, use its rating as the tie-breaker (4–5 positive, 1–3 negative).
- Preserve the exact review order, index, and reviewKey. Do not return explanations per review or any additional properties.
- Write all three summaries in clear, concise English. Summarize themes rather than reviewing individual comments one by one, and never quote or closely copy review wording.
- Helpful-vote count is an evidence-weight signal: give themes from more-helpful reviews greater consideration, but do not let one popular outlier erase corroborating or conflicting themes. A helpful vote does not prove a reviewer's claims are factual.
- The aggregate Amazon rating and total review count cover the full listing and must be the primary evidence for the overall tone. The extracted reviews are a recency-sorted, qualitatively balanced subset of up to ${AMAZON_REVIEW_LIMIT} reviews and are not a representative rating distribution. Never infer full-population percentages or prevalence from the extracted positive/negative counts.
- The overall summary must explicitly reconcile the aggregate rating/count with the extracted themes, including tensions when corpus criticism differs from the aggregate score.
- The positive summary must identify the most decision-relevant praised themes present in positive reviews. If there are no positive extracted reviews, say so plainly without inventing themes.
- The negative summary must identify the most decision-relevant objections, uncertainty, or friction present in negative reviews. If there are no negative extracted reviews, say so plainly without inventing concerns.
- Treat review claims as customer perceptions, not verified product facts. Do not recommend listing changes here; analysis will be consumed by a separate optimization step.
- Do not return markdown, marketplace metadata, commentary, or properties outside the specified JSON shape.`;

export function createReviewSentimentUserPrompt(
    market: string,
    reviews: ReviewSentimentContext
): string {
    return `Analyze the supplied review evidence and return the requested JSON object.

Marketplace context: ${market}

${JSON.stringify({
    aggregate: {
        overallRating: reviews.overallRating,
        ratingScaleMaximum: 5,
        totalReviewCount: reviews.totalCount
    },
    extractedCorpus: {
        maximumReviewCount: AMAZON_REVIEW_LIMIT,
        extractedReviewCount: reviews.items.length,
        reviews: reviews.items.map((review, index) => ({
            index,
            reviewKey: createReviewKey(review, index),
            rating: review.rating,
            title: review.title,
            comment: review.comment,
            date: review.date,
            verifiedPurchase: review.verifiedPurchase,
            variant: review.variant,
            helpfulCount: review.helpfulCount
        }))
    }
})}`;
}
import { createReviewKey } from "../review-key.js";
