import { z, ZodError } from "zod";
import { runExternalRequest } from "./external-request.js";
import {
    AMAZON_TITLE_CHARACTER_LIMIT,
    PRODUCT_OPTIMIZATION_SYSTEM_PROMPT
} from "./prompts/product-optimization.js";
import {
    suggestionsSchema,
    type Market,
    type ProductSuggestions,
    type ScrapedProduct
} from "./schemas.js";

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const DEEPSEEK_MODEL = "deepseek-v4-flash";
const MAX_ATTEMPTS = 3;
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
                        { role: "system", content: PRODUCT_OPTIMIZATION_SYSTEM_PROMPT },
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
