import { z } from "zod";
import { runExternalRequest } from "./external-request.js";
import {
    createProductOptimizationUserPrompt,
    PRODUCT_OPTIMIZATION_SYSTEM_PROMPT
} from "./prompts/product-optimization.js";
import { type Market, type ProductSuggestions, type ScrapedProduct } from "./schemas.js";
import { parseAndValidateSuggestions, SuggestionValidationError } from "./suggestion-validation.js";

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

const delay = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));

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

            const waitMilliseconds = 1_000 * 2 ** (attempt - 1);
            console.warn(`    ${error.message}. Retrying in ${waitMilliseconds}ms...`);
            await delay(waitMilliseconds);
        }
    }

    throw new DeepSeekError("DeepSeek request failed unexpectedly");
}
