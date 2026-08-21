import {
    analyzeReviewSentimentWithDeepSeek,
    DEEPSEEK_MODEL,
    suggestProductImprovementsWithDeepSeek,
    translateProductContentWithDeepSeek
} from "./deepseek.js";
import {
    analyzeReviewSentimentWithGemini,
    suggestProductImprovementsWithGemini,
    translateProductContentWithGemini
} from "./gemini.js";
import {
    type Market,
    type ProductEnglishTranslations,
    type ProductOptimizationProduct,
    type ProductReviews,
    type ProductSuggestions,
    type ReviewSentimentAnalysis,
    type ScrapedProduct,
    type SuggestionProvider
} from "./schemas.js";

export type SuggestionService = {
    provider: SuggestionProvider;
    providerName: "DeepSeek" | "Gemini";
    model: string;
    reportConfig: ReportAiConfig;
    suggest: (market: Market, product: ProductOptimizationProduct) => Promise<ProductSuggestions>;
    analyzeReviews: (market: Market, reviews: ProductReviews) => Promise<ReviewSentimentAnalysis>;
    translate: (
        market: Market,
        product: ScrapedProduct,
        suggestions: ProductSuggestions
    ) => Promise<ProductEnglishTranslations>;
};

export type ReportAiConfig = {
    provider: SuggestionProvider;
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
            model: DEEPSEEK_MODEL,
            apiKey: deepSeekApiKey
        };

        return {
            provider: reportConfig.provider,
            providerName: "DeepSeek",
            model: reportConfig.model,
            reportConfig,
            analyzeReviews: (market, reviews) =>
                analyzeReviewSentimentWithDeepSeek(deepSeekApiKey, market, reviews),
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
            model,
            apiKey: geminiApiKey
        };

        return {
            provider: reportConfig.provider,
            providerName: "Gemini",
            model: reportConfig.model,
            reportConfig,
            analyzeReviews: (market, reviews) =>
                analyzeReviewSentimentWithGemini(geminiApiKey, model, market, reviews),
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
