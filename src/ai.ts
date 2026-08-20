import {
    DEEPSEEK_MODEL,
    suggestProductImprovementsWithDeepSeek,
    translateProductContentWithDeepSeek
} from "./deepseek.js";
import { suggestProductImprovementsWithGemini, translateProductContentWithGemini } from "./gemini.js";
import {
    type Market,
    type ProductEnglishTranslations,
    type ProductSuggestions,
    type ScrapedProduct,
    type SuggestionProvider
} from "./schemas.js";

export type SuggestionService = {
    provider: SuggestionProvider;
    providerName: "DeepSeek" | "Gemini";
    model: string;
    reportConfig: ReportAiConfig;
    suggest: (market: Market, product: ScrapedProduct) => Promise<ProductSuggestions>;
    translate: (
        market: Market,
        product: ScrapedProduct,
        suggestions: ProductSuggestions
    ) => Promise<ProductEnglishTranslations>;
};

export type ReportAiConfig = {
    provider: SuggestionProvider;
    providerName: "DeepSeek" | "Gemini";
    model: string;
    apiKey: string;
};

function readValue(environment: NodeJS.ProcessEnv, name: string): string | undefined {
    const value = environment[name]?.trim();
    return value === "" ? undefined : value;
}

export function createSuggestionService(
    environment: NodeJS.ProcessEnv = process.env
): SuggestionService {
    const deepSeekApiKey = readValue(environment, "DEEPSEEK_API_KEY");
    const geminiApiKey = readValue(environment, "GEMINI_API_KEY");

    if (deepSeekApiKey && geminiApiKey) {
        throw new Error(
            "Both DEEPSEEK_API_KEY and GEMINI_API_KEY are configured. Set exactly one AI provider key."
        );
    }

    if (deepSeekApiKey) {
        const reportConfig: ReportAiConfig = {
            provider: "deepseek",
            providerName: "DeepSeek",
            model: DEEPSEEK_MODEL,
            apiKey: deepSeekApiKey
        };

        return {
            provider: reportConfig.provider,
            providerName: reportConfig.providerName,
            model: reportConfig.model,
            reportConfig,
            suggest: (market, product) =>
                suggestProductImprovementsWithDeepSeek(deepSeekApiKey, market, product),
            translate: (market, product, suggestions) =>
                translateProductContentWithDeepSeek(deepSeekApiKey, market, product, suggestions)
        };
    }

    if (geminiApiKey) {
        const rawModel = readValue(environment, "GEMINI_MODEL");
        if (!rawModel) {
            throw new Error(
                "GEMINI_MODEL is required when GEMINI_API_KEY is configured (for example: gemini-3.7-flash)."
            );
        }

        const model = rawModel.replace(/^models\//, "");
        if (!/^[A-Za-z0-9._-]+$/.test(model)) {
            throw new Error(`GEMINI_MODEL contains unsupported characters: ${rawModel}`);
        }

        const reportConfig: ReportAiConfig = {
            provider: "gemini",
            providerName: "Gemini",
            model,
            apiKey: geminiApiKey
        };

        return {
            provider: reportConfig.provider,
            providerName: reportConfig.providerName,
            model: reportConfig.model,
            reportConfig,
            suggest: (market, product) =>
                suggestProductImprovementsWithGemini(geminiApiKey, model, market, product),
            translate: (market, product, suggestions) =>
                translateProductContentWithGemini(geminiApiKey, model, market, product, suggestions)
        };
    }

    throw new Error(
        "No AI provider is configured. Set exactly one of DEEPSEEK_API_KEY or GEMINI_API_KEY."
    );
}
