import { z } from "zod";
import { runExternalRequest } from "./external-request.js";
import {
    createProductEnglishTranslationPrompt,
    ENGLISH_TRANSLATION_SYSTEM_PROMPT
} from "./prompts/english-translation.js";
import {
    createProductOptimizationUserPrompt,
    PRODUCT_OPTIMIZATION_SYSTEM_PROMPT
} from "./prompts/product-optimization.js";
import {
    type Market,
    type ProductEnglishTranslations,
    type ProductSuggestions,
    type ScrapedProduct
} from "./schemas.js";
import { parseAndValidateSuggestions, SuggestionValidationError } from "./suggestion-validation.js";
import {
    parseAndValidateProductEnglishTranslations,
    TranslationValidationError
} from "./translation-validation.js";

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
export const DEEPSEEK_MODEL = "deepseek-v4-flash";
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

class DeepSeekError extends Error {
    constructor(message: string, readonly retryable = false) {
        super(message);
    }
}

function getApiErrorMessage(value: unknown, status: number): string {
    const result = z
        .object({
            error: z.object({ message: z.string() })
        })
        .safeParse(value);

    return result.success ? result.data.error.message : `DeepSeek returned HTTP ${status}`;
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
                            content: createProductOptimizationUserPrompt(market, product)
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
            `DeepSeek returned an unexpected API response: ${completionResult.error.message}`,
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

    try {
        return parseAndValidateSuggestions(choice.message.content ?? "", product);
    } catch (error) {
        if (error instanceof SuggestionValidationError) {
            throw new DeepSeekError(`DeepSeek ${error.message}`, true);
        }
        throw error;
    }
}

async function requestTranslations(
    apiKey: string,
    market: Market,
    product: ScrapedProduct,
    suggestions: ProductSuggestions
): Promise<ProductEnglishTranslations> {
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
                    // Translation is direct text transformation. DeepSeek defaults to thinking
                    // mode, which adds substantial latency without helping this task.
                    thinking: { type: "disabled" },
                    messages: [
                        { role: "system", content: ENGLISH_TRANSLATION_SYSTEM_PROMPT },
                        {
                            role: "user",
                            content: createProductEnglishTranslationPrompt(market, product, suggestions)
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
        throw new DeepSeekError(`DeepSeek translation request failed: ${message}`, true);
    }

    let responseValue: unknown;
    try {
        responseValue = JSON.parse(responseText);
    } catch {
        throw new DeepSeekError(
            response.ok
                ? "DeepSeek returned a non-JSON translation API response"
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
            `DeepSeek returned an unexpected translation API response: ${completionResult.error.message}`,
            true
        );
    }

    const choice = completionResult.data.choices[0];
    if (choice.finish_reason !== "stop") {
        throw new DeepSeekError(
            `DeepSeek translation stopped with finish reason ${choice.finish_reason ?? "unknown"}`,
            choice.finish_reason === "insufficient_system_resource"
        );
    }

    try {
        return parseAndValidateProductEnglishTranslations(
            choice.message.content ?? "",
            product,
            suggestions,
            "DeepSeek"
        );
    } catch (error) {
        if (error instanceof TranslationValidationError) {
            throw new DeepSeekError(error.message, true);
        }
        throw error;
    }
}

export async function suggestProductImprovementsWithDeepSeek(
    apiKey: string,
    market: Market,
    product: ScrapedProduct
): Promise<ProductSuggestions> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        try {
            return await requestSuggestions(apiKey, market, product);
        } catch (error) {
            if (!(error instanceof DeepSeekError) || !error.retryable || attempt === MAX_ATTEMPTS) {
                throw error;
            }

            console.warn(`    ${error.message}. Retrying immediately...`);
        }
    }

    throw new DeepSeekError("DeepSeek request failed unexpectedly");
}

export async function translateProductContentWithDeepSeek(
    apiKey: string,
    market: Market,
    product: ScrapedProduct,
    suggestions: ProductSuggestions
): Promise<ProductEnglishTranslations> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        try {
            return await requestTranslations(apiKey, market, product, suggestions);
        } catch (error) {
            if (!(error instanceof DeepSeekError) || !error.retryable || attempt === MAX_ATTEMPTS) {
                throw error;
            }

            console.warn(`    ${error.message}. Retrying immediately...`);
        }
    }

    throw new DeepSeekError("DeepSeek translation request failed unexpectedly");
}
