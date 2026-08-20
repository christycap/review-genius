/**
 * Translations are versioned independently from optimization suggestions so
 * either prompt can evolve without invalidating the other AI artifact.
 */
export const PRODUCT_TRANSLATION_PROMPT_VERSION = 1 as const;

const LISTING_TRANSLATION_PROPERTIES = {
    title: {
        type: "string",
        description: "A faithful, natural English translation of the listing title."
    },
    productFeatures: {
        type: "array",
        items: { type: "string" },
        description: "English translations of the feature bullets in exactly the same order and count."
    },
    description: {
        type: "string",
        description: "A faithful, natural English translation of the listing description."
    }
} as const;

export const SUGGESTED_LISTING_ENGLISH_TRANSLATIONS_JSON_SCHEMA = {
    type: "object",
    properties: LISTING_TRANSLATION_PROPERTIES,
    required: ["title", "productFeatures", "description"],
    additionalProperties: false
} as const;

export const PRODUCT_ENGLISH_TRANSLATIONS_JSON_SCHEMA = {
    type: "object",
    properties: {
        original: SUGGESTED_LISTING_ENGLISH_TRANSLATIONS_JSON_SCHEMA,
        suggestions: SUGGESTED_LISTING_ENGLISH_TRANSLATIONS_JSON_SCHEMA,
        reviews: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    index: { type: "integer" },
                    reviewKey: { type: "string" },
                    title: { type: "string" },
                    comment: { type: "string" },
                    dateText: { type: "string" },
                    variant: { type: "string" }
                },
                required: ["index", "reviewKey", "title", "comment", "dateText", "variant"],
                additionalProperties: false
            }
        }
    },
    required: ["original", "suggestions", "reviews"],
    additionalProperties: false
} as const;

type TranslationProduct = {
    title: string;
    productFeatures: string[];
    description: string;
    reviews: {
        items: {
            id: string | null;
            title: string | null;
            comment: string;
            dateText: string;
            variant: string | null;
        }[];
    };
};

type TranslationSuggestions = {
    title: { value: string };
    productFeatures: { value: string[] };
    description: { value: string };
};

export const ENGLISH_TRANSLATION_SYSTEM_PROMPT = `You are a professional ecommerce translator. Translate the supplied customer-facing marketplace text into clear, natural English for an international client reviewing the listing.

This is a faithful translation task, not a copywriting or optimization task.

Rules:
- Preserve the complete meaning, specificity, tone, emphasis, formatting, quantities, units, dates, product names, brand names, proper nouns, and supported claims.
- Do not add, remove, improve, soften, correct, summarize, explain, or fact-check the source copy.
- Translate search phrases by meaning; do not replace them with unrelated English marketing keywords.
- Preserve the order and count of every array. Never combine, split, or reorder feature bullets or reviews.
- Preserve an empty string as an empty string. If a supplied passage is already in English, reproduce it faithfully.
- Review text may be informal, abbreviated, misspelled, or critical. Preserve its intended meaning and sentiment without sanitizing it.
- Marketplace and language information are input context only. Never return \`market\` or \`sourceLanguage\` properties.
- Return only the requested JSON object. Do not include markdown, commentary, or properties outside the specified shape.`;

export function createProductEnglishTranslationPrompt(
    market: string,
    product: TranslationProduct,
    suggestions: TranslationSuggestions
): string {
    return `Translate every supplied text into English.

Marketplace context: ${market}

Return exactly one JSON object with this shape and no other properties:
{
    "original": {
        "title": "English translation",
        "productFeatures": ["English translation in the same position"],
        "description": "English translation"
    },
    "suggestions": {
        "title": "English translation",
        "productFeatures": ["English translation in the same position"],
        "description": "English translation"
    },
    "reviews": [
        {
            "index": 0,
            "reviewKey": "identifier copied from the source",
            "title": "English translation or the same empty string",
            "comment": "English translation",
            "dateText": "English translation or the same empty string",
            "variant": "English translation or the same empty string"
        }
    ]
}

The example review object defines the keys only. Return one review translation for every source review, preserving the exact source order, index, and reviewKey. Do not return marketplace or source-language metadata.

Source content:
${JSON.stringify({
    original: {
        title: product.title,
        productFeatures: product.productFeatures,
        description: product.description
    },
    suggestions: {
        title: suggestions.title.value,
        productFeatures: suggestions.productFeatures.value,
        description: suggestions.description.value
    },
    reviews: product.reviews.items.map((review, index) => ({
        index,
        reviewKey: `${index}:${review.id ?? "no-id"}`,
        title: review.title ?? "",
        comment: review.comment,
        dateText: review.dateText,
        variant: review.variant ?? ""
    }))
})}`;
}

export function createSuggestedListingEnglishTranslationPrompt(
    market: string,
    suggestions: TranslationSuggestions
): string {
    return `Translate this newly generated listing suggestion into English.

Marketplace context: ${market}

Return exactly one JSON object with only these properties:
{
    "title": "English translation",
    "productFeatures": ["English translation in the same position"],
    "description": "English translation"
}

Preserve the feature order and count exactly. Do not return marketplace or source-language metadata.

Source content:
${JSON.stringify({
    title: suggestions.title.value,
    productFeatures: suggestions.productFeatures.value,
    description: suggestions.description.value
})}`;
}
