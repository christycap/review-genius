import { z } from "zod";
import type { ReportAiConfig } from "../ai.js";
import {
    createSuggestedListingEnglishTranslationPrompt,
    ENGLISH_TRANSLATION_SYSTEM_PROMPT,
    SUGGESTED_LISTING_ENGLISH_TRANSLATIONS_JSON_SCHEMA
} from "../prompts/english-translation.js";
import {
    createProductRefinementUserPrompt,
    PRODUCT_OPTIMIZATION_SYSTEM_PROMPT,
    PRODUCT_SUGGESTIONS_JSON_SCHEMA
} from "../prompts/product-optimization.js";
import type {
    ListingEnglishTranslations,
    Market,
    ProductSuggestions,
    RefinedSuggestions,
    ScrapedProduct
} from "../schemas.js";
import { parseAndValidateSuggestions, SuggestionValidationError } from "../suggestion-validation.js";
import {
    parseAndValidateListingEnglishTranslations,
    TranslationValidationError
} from "../translation-validation.js";

const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const GEMINI_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const MAX_ATTEMPTS = 3;

const deepSeekResponseSchema = z.object({
    choices: z
        .array(
            z.object({
                finish_reason: z.string().nullable(),
                message: z.object({ content: z.string().nullable() })
            })
        )
        .min(1)
});

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

class BrowserAiError extends Error {
    constructor(message: string, readonly retryable = false) {
        super(message);
    }
}

function isRetryableStatus(status: number): boolean {
    return status === 408 || status === 429 || status >= 500;
}

function getApiErrorMessage(value: unknown, status: number): string {
    const result = z
        .object({
            error: z.object({ message: z.string() })
        })
        .safeParse(value);

    return result.success ? result.data.error.message : `HTTP ${status}`;
}

function normalizeText(value: string): string {
    return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function suggestionValuesAreEqual(first: ProductSuggestions, second: ProductSuggestions): boolean {
    return (
        normalizeText(first.title.value) === normalizeText(second.title.value) &&
        first.productFeatures.value.length === second.productFeatures.value.length &&
        first.productFeatures.value.every(
            (feature, index) =>
                normalizeText(feature) === normalizeText(second.productFeatures.value[index])
        ) &&
        normalizeText(first.description.value) === normalizeText(second.description.value)
    );
}

function validateResponse(
    providerName: string,
    content: string,
    product: ScrapedProduct,
    currentSuggestions: ProductSuggestions | undefined
): ProductSuggestions {
    try {
        const suggestions = parseAndValidateSuggestions(content, product);
        if (
            currentSuggestions !== undefined &&
            suggestionValuesAreEqual(suggestions, currentSuggestions)
        ) {
            throw new BrowserAiError(`${providerName} returned the current suggestion unchanged`, true);
        }

        return suggestions;
    } catch (error) {
        if (error instanceof SuggestionValidationError) {
            throw new BrowserAiError(`${providerName} ${error.message}`, true);
        }
        throw error;
    }
}

async function readJsonResponse(response: Response, providerName: string): Promise<unknown> {
    const responseText = await response.text();
    let responseValue: unknown;

    try {
        responseValue = JSON.parse(responseText);
    } catch {
        throw new BrowserAiError(
            response.ok
                ? `${providerName} returned a non-JSON response`
                : `${providerName} returned HTTP ${response.status}`,
            isRetryableStatus(response.status)
        );
    }

    if (!response.ok) {
        throw new BrowserAiError(
            `${providerName}: ${getApiErrorMessage(responseValue, response.status)}`,
            isRetryableStatus(response.status)
        );
    }

    return responseValue;
}

async function fetchFromBrowser(
    providerName: string,
    input: RequestInfo | URL,
    init: RequestInit
): Promise<unknown> {
    let response: Response;

    try {
        response = await fetch(input, {
            ...init,
            signal: AbortSignal.timeout(240_000)
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new BrowserAiError(
            `${providerName} could not be reached from this browser (${message}). Check the internet connection, API key restrictions, and browser cross-origin policy.`
        );
    }

    return readJsonResponse(response, providerName);
}

async function requestDeepSeekSuggestions(
    config: ReportAiConfig,
    market: Market,
    product: ScrapedProduct,
    currentSuggestions: ProductSuggestions | undefined,
    feedback: string
): Promise<ProductSuggestions> {
    const responseValue = await fetchFromBrowser(config.providerName, DEEPSEEK_URL, {
        method: "POST",
        headers: {
            authorization: `Bearer ${config.apiKey}`,
            "content-type": "application/json"
        },
        body: JSON.stringify({
            model: config.model,
            thinking: { type: "enabled" },
            reasoning_effort: "high",
            messages: [
                { role: "system", content: PRODUCT_OPTIMIZATION_SYSTEM_PROMPT },
                {
                    role: "user",
                    content: createProductRefinementUserPrompt(
                        market,
                        product,
                        currentSuggestions,
                        feedback
                    )
                }
            ],
            response_format: { type: "json_object" },
            max_tokens: 32_768
        })
    });

    const result = deepSeekResponseSchema.safeParse(responseValue);
    if (!result.success) {
        throw new BrowserAiError(
            `DeepSeek returned an unexpected response: ${result.error.message}`,
            true
        );
    }

    const choice = result.data.choices[0];
    if (choice.finish_reason !== "stop") {
        throw new BrowserAiError(
            `DeepSeek stopped with finish reason ${choice.finish_reason ?? "unknown"}`,
            choice.finish_reason === "insufficient_system_resource"
        );
    }

    return validateResponse(
        config.providerName,
        choice.message.content ?? "",
        product,
        currentSuggestions
    );
}

async function requestGeminiSuggestions(
    config: ReportAiConfig,
    market: Market,
    product: ScrapedProduct,
    currentSuggestions: ProductSuggestions | undefined,
    feedback: string
): Promise<ProductSuggestions> {
    const responseValue = await fetchFromBrowser(
        config.providerName,
        `${GEMINI_API_BASE_URL}/${encodeURIComponent(config.model)}:generateContent`,
        {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-goog-api-key": config.apiKey
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
                                text: createProductRefinementUserPrompt(
                                    market,
                                    product,
                                    currentSuggestions,
                                    feedback
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
                            schema: PRODUCT_SUGGESTIONS_JSON_SCHEMA
                        }
                    }
                }
            })
        }
    );

    const result = geminiResponseSchema.safeParse(responseValue);
    if (!result.success) {
        throw new BrowserAiError(
            `Gemini returned an unexpected response: ${result.error.message}`,
            true
        );
    }

    const candidate = result.data.candidates[0];
    if (candidate.finishReason !== "STOP") {
        throw new BrowserAiError(
            `Gemini stopped with finish reason ${candidate.finishReason ?? "unknown"}`,
            candidate.finishReason === "MAX_TOKENS" || candidate.finishReason === "OTHER"
        );
    }

    const content =
        candidate.content?.parts
            .filter(part => part.thought !== true)
            .map(part => part.text ?? "")
            .join("") ?? "";

    return validateResponse(config.providerName, content, product, currentSuggestions);
}

function validateTranslationResponse(
    providerName: string,
    content: string,
    suggestions: ProductSuggestions
): ListingEnglishTranslations {
    try {
        return parseAndValidateListingEnglishTranslations(content, suggestions, providerName);
    } catch (error) {
        if (error instanceof TranslationValidationError) {
            throw new BrowserAiError(error.message, true);
        }
        throw error;
    }
}

async function requestDeepSeekTranslations(
    config: ReportAiConfig,
    market: Market,
    suggestions: ProductSuggestions
): Promise<ListingEnglishTranslations> {
    const responseValue = await fetchFromBrowser(config.providerName, DEEPSEEK_URL, {
        method: "POST",
        headers: {
            authorization: `Bearer ${config.apiKey}`,
            "content-type": "application/json"
        },
        body: JSON.stringify({
            model: config.model,
            // Keep browser refinements consistent with build-time translations: the optimization
            // request reasons deeply, while the following translation request does not.
            thinking: { type: "disabled" },
            messages: [
                { role: "system", content: ENGLISH_TRANSLATION_SYSTEM_PROMPT },
                {
                    role: "user",
                    content: createSuggestedListingEnglishTranslationPrompt(market, suggestions)
                }
            ],
            response_format: { type: "json_object" },
            max_tokens: 16_384
        })
    });

    const result = deepSeekResponseSchema.safeParse(responseValue);
    if (!result.success) {
        throw new BrowserAiError(
            `DeepSeek returned an unexpected translation response: ${result.error.message}`,
            true
        );
    }

    const choice = result.data.choices[0];
    if (choice.finish_reason !== "stop") {
        throw new BrowserAiError(
            `DeepSeek translation stopped with finish reason ${choice.finish_reason ?? "unknown"}`,
            choice.finish_reason === "insufficient_system_resource"
        );
    }

    return validateTranslationResponse(config.providerName, choice.message.content ?? "", suggestions);
}

async function requestGeminiTranslations(
    config: ReportAiConfig,
    market: Market,
    suggestions: ProductSuggestions
): Promise<ListingEnglishTranslations> {
    const responseValue = await fetchFromBrowser(
        config.providerName,
        `${GEMINI_API_BASE_URL}/${encodeURIComponent(config.model)}:generateContent`,
        {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "x-goog-api-key": config.apiKey
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
                                text: createSuggestedListingEnglishTranslationPrompt(market, suggestions)
                            }
                        ]
                    }
                ],
                generationConfig: {
                    maxOutputTokens: 16_384,
                    responseFormat: {
                        text: {
                            mimeType: "APPLICATION_JSON",
                            schema: SUGGESTED_LISTING_ENGLISH_TRANSLATIONS_JSON_SCHEMA
                        }
                    }
                }
            })
        }
    );

    const result = geminiResponseSchema.safeParse(responseValue);
    if (!result.success) {
        throw new BrowserAiError(
            `Gemini returned an unexpected translation response: ${result.error.message}`,
            true
        );
    }

    const candidate = result.data.candidates[0];
    if (candidate.finishReason !== "STOP") {
        throw new BrowserAiError(
            `Gemini translation stopped with finish reason ${candidate.finishReason ?? "unknown"}`,
            candidate.finishReason === "MAX_TOKENS" || candidate.finishReason === "OTHER"
        );
    }

    const content =
        candidate.content?.parts
            .filter(part => part.thought !== true)
            .map(part => part.text ?? "")
            .join("") ?? "";

    return validateTranslationResponse(config.providerName, content, suggestions);
}

async function retryBrowserRequest<T>(request: () => Promise<T>): Promise<T> {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        try {
            return await request();
        } catch (error) {
            if (!(error instanceof BrowserAiError) || !error.retryable || attempt === MAX_ATTEMPTS) {
                throw error;
            }

            // A new response may satisfy deterministic validation; no artificial wait is needed.
        }
    }

    throw new BrowserAiError("AI request failed unexpectedly");
}

export async function regenerateSuggestions(
    config: ReportAiConfig,
    market: Market,
    product: ScrapedProduct,
    currentSuggestions: ProductSuggestions | undefined,
    feedback: string
): Promise<RefinedSuggestions> {
    const suggestions = await retryBrowserRequest(() =>
        config.provider === "deepseek"
            ? requestDeepSeekSuggestions(config, market, product, currentSuggestions, feedback)
            : requestGeminiSuggestions(config, market, product, currentSuggestions, feedback)
    );
    const englishTranslations = await retryBrowserRequest(() =>
        config.provider === "deepseek"
            ? requestDeepSeekTranslations(config, market, suggestions)
            : requestGeminiTranslations(config, market, suggestions)
    );

    return { suggestions, englishTranslations };
}
