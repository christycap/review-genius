import { z, ZodError } from "zod";
import { runExternalRequest } from "./external-request.js";
import {
    suggestionsSchema,
    type Market,
    type ProductSuggestions,
    type ScrapedProduct
} from "./schemas.js";

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const DEEPSEEK_MODEL = "deepseek-v4-flash";
const MAX_ATTEMPTS = 3;
const AMAZON_TITLE_CHARACTER_LIMIT = 75;
const COMPLACENT_REASONING_PATTERNS = [
    /\bno (?:material )?changes? (?:are |were )?(?:needed|required)\b/i,
    /\b(?:kept|left|leave) .{0,50} as[- ]is\b/i,
    /\balready (?:clear|concise|effective|optimized|optimal|strong|well[- ](?:structured|written|optimized))\b/i
];

const completionSchema = z.object({
    choices: z
        .array(
            z.object({
                finish_reason: z.string().nullable(),
                message: z.object({
                    content: z.string().nullable()
                })
            })
        )
        .min(1)
});

// Editorial framework reviewed on 2026-08-14 and distilled from:
// - Amazon's current EU title policy and Item Highlights announcement:
//   https://sellercentral-europe.amazon.com/seller-forums/discussions/t/145b6d0f-999c-4555-896c-c694bda2e470
// - Amazon's listing, keyword, bullet-point, and advertising guidance:
//   https://sell.amazon.com/blog/amazon-product-listings
//   https://sell.amazon.com/blog/amazon-keyword-research
//   https://sell.amazon.com/blog/amazon-seo
//   https://advertising.amazon.com/en-ca/library/guides/improve-your-products-for-advertising
// - Baymard Institute's large-scale product-page usability research:
//   https://baymard.com/blog/product-descriptions
//   https://baymard.com/blog/structure-descriptions-by-highlights
const SYSTEM_PROMPT = `You are a conversion-focused Amazon marketplace copy strategist. Your goal is to maximize qualified purchase conversion: help the right shopper discover the product, understand it quickly, feel confident about what is offered, and choose it without creating expectations the product cannot meet.

This is an optimization task, not an evaluation task. Produce a materially improved version of the title, feature list, and description every time. Never return a field unchanged, never say that no changes are needed, and never praise the source as already perfect. Even when the source is strong, improve its prioritization, mobile readability, specificity, persuasive clarity, or handling of customer questions.

Return only a JSON object with exactly this shape:
{
    "title": {
        "value": "the improved title",
        "reasoning": "a concise explanation of why this title is better"
    },
    "productFeatures": {
        "value": ["improved feature one", "improved feature two"],
        "reasoning": "a concise explanation of why this feature list is better"
    },
    "description": {
        "value": "the improved description",
        "reasoning": "a concise explanation of why this description is better"
    }
}

Rules:
- Infer the source language from the supplied listing. Write every suggested value in that same source language; do not translate the proposed listing copy into English.
- Write every reasoning field in English, regardless of the listing's source language. This is mandatory so the explanations remain consistent across markets.
- Use only facts present in the title, product features, or description. A benefit is allowed only when it follows directly and conservatively from an explicit product fact. Never invent specifications, quantities, certifications, rankings, guarantees, availability, prices, inclusions, locations, or outcomes.
- Treat the aggregate rating and total count as context, not proof that the listing copy is effective. Extracted reviews are a small qualitative sample: use recurring themes to prioritize factual benefits, vocabulary, questions, and objections, but never present a reviewer's subjective claim as a product fact. Do not quote or closely copy review text.

Conversion framework distilled from current Amazon guidance and ecommerce usability research:
- Optimize for four shopper decisions: recognition (what is it?), relevance (is it for me?), confidence (what exactly do I get and how does it work?), and desire (why is this experience worth choosing?).
- Prefer concrete, decision-relevant information over generic adjectives. Remove duplicated ideas, vague praise, filler, awkward phrasing, and keyword stuffing.
- Preserve important source facts, but reorganize them aggressively when a different hierarchy makes the offer easier to compare and understand.
- Use natural search terms already supported by the source, especially the product type, intended recipient or group, core experience, duration, and principal inclusion. Never fabricate keyword data or claim search volume.

Title criteria:
- The suggested title must contain at most ${AMAZON_TITLE_CHARACTER_LIMIT} Unicode characters including spaces, reflecting Amazon's current non-media title requirement and mobile display guidance.
- Front-load the brand, recognizable product type, and strongest differentiating facts. Retain only the most purchase-decisive attributes that fit naturally; move secondary detail into the feature list.
- Make the offer identifiable when scanned alone. Avoid promotional claims, repeated words, unnecessary punctuation, keyword chains, and details that do not help a shopper choose.

Feature-list criteria:
- Produce 3 to 5 distinct bullets when the source contains enough facts. Order them by decision value, not by the source order.
- Begin each bullet with a short, meaningful benefit or attribute label, followed by concrete supporting detail. Make each bullet independently scannable and avoid repeating the title or another bullet.
- Cover the strongest supported value proposition first, then what is included, choice or flexibility, practical mechanics or validity, and reassurance where those facts exist. Use review themes to decide which supported details deserve prominence or clarification.

Description criteria:
- Write a persuasive broad-strokes overview that complements rather than repeats the title and bullets.
- Open with a concrete value proposition, then use short paragraphs or line breaks to develop the most important experience highlights and decision details. Avoid both a thin generic summary and an intimidating wall of text.
- Give shoppers a clear mental picture of the offer and reduce uncertainty using only available facts. Connect factual features to customer value in natural language, without hype or guaranteed emotional outcomes.

Reasoning criteria:
- Each reasoning field must contain 2 to 3 concise English sentences naming the most important concrete changes and why they should improve discoverability, comprehension, confidence, or conversion.
- Mention relevant review evidence when it materially influenced prioritization, but clearly frame it as a signal from the extracted reviews rather than a universal customer claim.
- Provide only a user-facing editorial rationale, never hidden chain-of-thought or step-by-step internal analysis.

- Silently audit all three proposals against this framework before responding. The suggested values must be materially different from their source fields.
- Do not include markdown, commentary, the ASIN, or any properties outside the specified JSON shape.`;

class DeepSeekError extends Error {
    constructor(message: string, readonly retryable = false) {
        super(message);
    }
}

const delay = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));

function formatZodError(error: ZodError): string {
    return error.issues
        .map(issue => `${issue.path.length === 0 ? "response" : issue.path.join(".")}: ${issue.message}`)
        .join("; ");
}

function getApiErrorMessage(value: unknown, status: number): string {
    const result = z
        .object({
            error: z.object({ message: z.string() })
        })
        .safeParse(value);

    return result.success ? result.data.error.message : `DeepSeek returned HTTP ${status}`;
}

function parseSuggestions(content: string): ProductSuggestions {
    if (content.trim() === "") {
        throw new DeepSeekError("DeepSeek returned an empty response", true);
    }

    let value: unknown;
    try {
        value = JSON.parse(content);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new DeepSeekError(`DeepSeek returned invalid JSON: ${message}`, true);
    }

    const result = suggestionsSchema.safeParse(value);
    if (!result.success) {
        throw new DeepSeekError(
            `DeepSeek returned suggestions in an invalid shape: ${formatZodError(result.error)}`,
            true
        );
    }

    return result.data;
}

function normalizeText(value: string): string {
    return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function validateSuggestions(product: ScrapedProduct, suggestions: ProductSuggestions): void {
    const issues: string[] = [];
    const suggestedTitleLength = Array.from(suggestions.title.value).length;

    if (suggestedTitleLength > AMAZON_TITLE_CHARACTER_LIMIT) {
        issues.push(
            `title.value contains ${suggestedTitleLength} characters; maximum is ${AMAZON_TITLE_CHARACTER_LIMIT}`
        );
    }

    if (normalizeText(suggestions.title.value) === normalizeText(product.title)) {
        issues.push("title.value is unchanged");
    }

    const originalFeatures = product.productFeatures.map(normalizeText);
    const suggestedFeatures = suggestions.productFeatures.value.map(normalizeText);
    if (suggestedFeatures.length < 3 || suggestedFeatures.length > 5) {
        issues.push(
            `productFeatures.value contains ${suggestedFeatures.length} bullets; expected 3 to 5`
        );
    }

    if (
        originalFeatures.length === suggestedFeatures.length &&
        originalFeatures.every((feature, index) => feature === suggestedFeatures[index])
    ) {
        issues.push("productFeatures.value is unchanged");
    }

    if (normalizeText(suggestions.description.value) === normalizeText(product.description)) {
        issues.push("description.value is unchanged");
    }

    const reasoningFields = [
        ["title.reasoning", suggestions.title.reasoning],
        ["productFeatures.reasoning", suggestions.productFeatures.reasoning],
        ["description.reasoning", suggestions.description.reasoning]
    ] as const;
    for (const [field, reasoning] of reasoningFields) {
        if (COMPLACENT_REASONING_PATTERNS.some(pattern => pattern.test(reasoning))) {
            issues.push(`${field} contains a no-improvement rationale`);
        }
    }

    if (issues.length > 0) {
        throw new DeepSeekError(
            `DeepSeek did not produce a compliant optimization: ${issues.join("; ")}`,
            true
        );
    }
}

async function requestSuggestions(
    apiKey: string,
    market: Market,
    product: ScrapedProduct
): Promise<ProductSuggestions> {
    let response: Response;
    let responseText: string;

    try {
        ({ response, responseText } = await runExternalRequest(async () => {
            const response = await fetch(DEEPSEEK_URL, {
                method: "POST",
                headers: {
                    authorization: `Bearer ${apiKey}`,
                    "content-type": "application/json"
                },
                body: JSON.stringify({
                    model: DEEPSEEK_MODEL,
                    thinking: { type: "enabled" },
                    reasoning_effort: "high",
                    messages: [
                        { role: "system", content: SYSTEM_PROMPT },
                        {
                            role: "user",
                            content: `Improve this product listing and return the requested JSON object:\n${JSON.stringify(
                                {
                                    market,
                                    title: product.title,
                                    productFeatures: product.productFeatures,
                                    description: product.description,
                                    reviews: product.reviews
                                }
                            )}`
                        }
                    ],
                    response_format: { type: "json_object" },
                    max_tokens: 32_768
                }),
                signal: AbortSignal.timeout(240_000)
            });

            return { response, responseText: await response.text() };
        }));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new DeepSeekError(`DeepSeek request failed: ${message}`, true);
    }

    let responseValue: unknown;

    try {
        responseValue = JSON.parse(responseText);
    } catch {
        throw new DeepSeekError(
            response.ok
                ? "DeepSeek returned a non-JSON API response"
                : `DeepSeek returned HTTP ${response.status}`,
            response.status === 429 || response.status >= 500
        );
    }

    if (!response.ok) {
        throw new DeepSeekError(
            getApiErrorMessage(responseValue, response.status),
            response.status === 408 || response.status === 429 || response.status >= 500
        );
    }

    const completionResult = completionSchema.safeParse(responseValue);
    if (!completionResult.success) {
        throw new DeepSeekError(
            `DeepSeek returned an unexpected API response: ${formatZodError(completionResult.error)}`,
            true
        );
    }

    const choice = completionResult.data.choices[0];
    if (choice.finish_reason !== "stop") {
        throw new DeepSeekError(
            `DeepSeek stopped with finish reason ${choice.finish_reason ?? "unknown"}`,
            choice.finish_reason === "insufficient_system_resource"
        );
    }

    const suggestions = parseSuggestions(choice.message.content ?? "");
    validateSuggestions(product, suggestions);
    return suggestions;
}

export async function suggestProductImprovements(
    market: Market,
    product: ScrapedProduct
): Promise<ProductSuggestions> {
    const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
    if (!apiKey) {
        throw new DeepSeekError("DEEPSEEK_API_KEY is missing or empty in .env");
    }

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        try {
            return await requestSuggestions(apiKey, market, product);
        } catch (error) {
            if (!(error instanceof DeepSeekError) || !error.retryable || attempt === MAX_ATTEMPTS) {
                throw error;
            }

            const waitMilliseconds = 1_000 * 2 ** (attempt - 1);
            console.warn(`    ${error.message}. Retrying in ${waitMilliseconds}ms...`);
            await delay(waitMilliseconds);
        }
    }

    throw new DeepSeekError("DeepSeek request failed unexpectedly");
}
