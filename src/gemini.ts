import { z } from "zod";
import { runExternalRequest } from "./external-request.js";
import {
    createProductEnglishTranslationPrompt,
    ENGLISH_TRANSLATION_SYSTEM_PROMPT,
    PRODUCT_ENGLISH_TRANSLATIONS_JSON_SCHEMA
} from "./prompts/english-translation.js";
import {
    createProductOptimizationUserPrompt,
    PRODUCT_OPTIMIZATION_SYSTEM_PROMPT,
    PRODUCT_SUGGESTIONS_JSON_SCHEMA
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

const GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const MAX_ATTEMPTS = 3;

const geminiResponseSchema = z
    .object({
        candidates: z
            .array(
                z
                    .object({
                        finishReason: z.string().optional(),
                        content: z
                            .object({
                                parts: z.array(
                                    z
                                        .object({
                                            text: z.string().optional(),
                                            thought: z.boolean().optional()
                                        })
                                        .passthrough()
                                )
                            })
                            .passthrough()
                            .optional()
                    })
                    .passthrough()
            )
            .min(1)
    })
    .passthrough();

class GeminiError extends Error {
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

    return result.success ? result.data.error.message : `Gemini returned HTTP ${status}`;
}

async function requestSuggestions(
    apiKey: string,
    model: string,
    market: Market,
    product: ScrapedProduct
): Promise<ProductSuggestions> {
    let response: Response;
    let responseText: string;

    try {
        ({ response, responseText } = await runExternalRequest(async () => {
            const response = await fetch(
                `${GEMINI_API_BASE_URL}/${encodeURIComponent(model)}:generateContent`,
                {
                    method: "POST",
                    headers: {
                        "content-type": "application/json",
                        "x-goog-api-key": apiKey
                    },
                    body: JSON.stringify({
                        systemInstruction: {
                            parts: [{ text: PRODUCT_OPTIMIZATION_SYSTEM_PROMPT }]
                        },
                        contents: [
                            {
                                role: "user",
                                parts: [
                                    {
                                        text: createProductOptimizationUserPrompt(market, product)
                                    }
                                ]
                            }
                        ],
                        generationConfig: {
                            maxOutputTokens: 32_768,
                            responseFormat: {
                                text: {
                                    mimeType: "APPLICATION_JSON",
                                    schema: PRODUCT_SUGGESTIONS_JSON_SCHEMA
                                }
                            }
                        }
                    }),
                    signal: AbortSignal.timeout(240_000)
                }
            );

            return { response, responseText: await response.text() };
        }));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new GeminiError(`Gemini request failed: ${message}`, true);
    }

    let responseValue: unknown;
    try {
        responseValue = JSON.parse(responseText);
    } catch {
        throw new GeminiError(
            response.ok
                ? "Gemini returned a non-JSON API response"
                : `Gemini returned HTTP ${response.status}`,
            response.status === 429 || response.status >= 500
        );
    }

    if (!response.ok) {
        throw new GeminiError(
            getApiErrorMessage(responseValue, response.status),
            response.status === 408 || response.status === 429 || response.status >= 500
        );
    }

    const result = geminiResponseSchema.safeParse(responseValue);
    if (!result.success) {
        throw new GeminiError(`Gemini returned an unexpected API response: ${result.error.message}`);
    }

    const candidate = result.data.candidates[0];
    if (candidate.finishReason !== "STOP") {
        throw new GeminiError(
            `Gemini stopped with finish reason ${candidate.finishReason ?? "unknown"}`,
            candidate.finishReason === "MAX_TOKENS" || candidate.finishReason === "OTHER"
        );
    }

    const content =
        candidate.content?.parts
            .filter(part => part.thought !== true)
            .map(part => part.text ?? "")
            .join("") ?? "";

    try {
        return parseAndValidateSuggestions(content, product);
    } catch (error) {
        if (error instanceof SuggestionValidationError) {
            throw new GeminiError(`Gemini ${error.message}`, true);
        }
        throw error;
    }
}

async function requestTranslations(
    apiKey: string,
    model: string,
    market: Market,
    product: ScrapedProduct,
    suggestions: ProductSuggestions
): Promise<ProductEnglishTranslations> {
    let response: Response;
    let responseText: string;

    try {
        ({ response, responseText } = await runExternalRequest(async () => {
            const response = await fetch(
                `${GEMINI_API_BASE_URL}/${encodeURIComponent(model)}:generateContent`,
                {
                    method: "POST",
                    headers: {
                        "content-type": "application/json",
                        "x-goog-api-key": apiKey
                    },
                    body: JSON.stringify({
                        systemInstruction: {
                            parts: [{ text: ENGLISH_TRANSLATION_SYSTEM_PROMPT }]
                        },
                        contents: [
                            {
                                role: "user",
                                parts: [
                                    {
                                        text: createProductEnglishTranslationPrompt(
                                            market,
                                            product,
                                            suggestions
                                        )
                                    }
                                ]
                            }
                        ],
                        generationConfig: {
                            maxOutputTokens: 32_768,
                            responseFormat: {
                                text: {
                                    mimeType: "APPLICATION_JSON",
                                    schema: PRODUCT_ENGLISH_TRANSLATIONS_JSON_SCHEMA
                                }
                            }
                        }
                    }),
                    signal: AbortSignal.timeout(240_000)
                }
            );

            return { response, responseText: await response.text() };
        }));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new GeminiError(`Gemini translation request failed: ${message}`, true);
    }

    let responseValue: unknown;
    try {
        responseValue = JSON.parse(responseText);
    } catch {
        throw new GeminiError(
            response.ok
                ? "Gemini returned a non-JSON translation API response"
                : `Gemini returned HTTP ${response.status}`,
            response.status === 429 || response.status >= 500
        );
    }

    if (!response.ok) {
        throw new GeminiError(
            getApiErrorMessage(responseValue, response.status),
            response.status === 408 || response.status === 429 || response.status >= 500
        );
    }

    const result = geminiResponseSchema.safeParse(responseValue);
    if (!result.success) {
        throw new GeminiError(
            `Gemini returned an unexpected translation API response: ${result.error.message}`,
            true
        );
    }

    const candidate = result.data.candidates[0];
    if (candidate.finishReason !== "STOP") {
        throw new GeminiError(
            `Gemini translation stopped with finish reason ${candidate.finishReason ?? "unknown"}`,
            candidate.finishReason === "MAX_TOKENS" || candidate.finishReason === "OTHER"
        );
    }

    const content =
        candidate.content?.parts
            .filter(part => part.thought !== true)
            .map(part => part.text ?? "")
            .join("") ?? "";

    try {
        return parseAndValidateProductEnglishTranslations(content, product, suggestions, "Gemini");
    } catch (error) {
        if (error instanceof TranslationValidationError) {
            throw new GeminiError(error.message, true);
        }
        throw error;
    }
}

export async function suggestProductImprovementsWithGemini(
    apiKey: string,
    model: string,
    market: Market,
    product: ScrapedProduct
): Promise<ProductSuggestions> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        try {
            return await requestSuggestions(apiKey, model, market, product);
        } catch (error) {
            if (!(error instanceof GeminiError) || !error.retryable || attempt === MAX_ATTEMPTS) {
                throw error;
            }

            console.warn(`    ${error.message}. Retrying immediately...`);
        }
    }

    throw new GeminiError("Gemini request failed unexpectedly");
}

export async function translateProductContentWithGemini(
    apiKey: string,
    model: string,
    market: Market,
    product: ScrapedProduct,
    suggestions: ProductSuggestions
): Promise<ProductEnglishTranslations> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        try {
            return await requestTranslations(apiKey, model, market, product, suggestions);
        } catch (error) {
            if (!(error instanceof GeminiError) || !error.retryable || attempt === MAX_ATTEMPTS) {
                throw error;
            }

            console.warn(`    ${error.message}. Retrying immediately...`);
        }
    }

    throw new GeminiError("Gemini translation request failed unexpectedly");
}
