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

const SYSTEM_PROMPT = `You are a senior ecommerce copy editor specializing in Amazon product listings.

Improve the supplied title, product feature list, and description. Return only a JSON object with exactly this shape:
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
- Infer the source language from the supplied listing. Write every suggested value and every reasoning field in that same language.
- Use only facts present in the title, product features, or description. Never invent specifications, quantities, certifications, rankings, guarantees, availability, prices, or product benefits.
- Review context includes Amazon's aggregate rating and total review count, plus extracted review items with rating, title, and comment. Use it to identify what customers value or find unclear, but subjective review claims are not product facts. Do not quote or closely copy review text.
- Make the title clear, natural, concise, and easy to scan. Avoid keyword stuffing, repetition, and unsupported superlatives.
- Make the feature list easy to scan, remove redundancy, and put customer-relevant information first without losing important factual details.
- Make the description coherent, persuasive, and well structured while preserving the meaning of the source.
- Each reasoning field must be a short, user-facing justification of the concrete editorial improvements, not hidden chain-of-thought or a step-by-step analysis.
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
                    thinking: { type: "disabled" },
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
                    max_tokens: 4_096,
                    temperature: 0.2
                }),
                signal: AbortSignal.timeout(120_000)
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

    return parseSuggestions(choice.message.content ?? "");
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
