import type { ZodError } from "zod";
import {
    listingEnglishTranslationsSchema,
    productEnglishTranslationsSchema,
    type ListingEnglishTranslations,
    type ProductEnglishTranslations,
    type ProductSuggestions,
    type ScrapedProduct
} from "./schemas.js";

export class TranslationValidationError extends Error {}

function formatZodError(error: ZodError): string {
    const groupedIssues = new Map<string, number>();

    for (const issue of error.issues) {
        const path =
            issue.path.length === 0
                ? "response"
                : issue.path.map(segment => (typeof segment === "number" ? "*" : segment)).join(".");
        const message = `${path}: ${issue.message}`;
        groupedIssues.set(message, (groupedIssues.get(message) ?? 0) + 1);
    }

    return [...groupedIssues]
        .map(([message, count]) => `${message}${count > 1 ? ` (${count} occurrences)` : ""}`)
        .join("; ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * DeepSeek JSON mode can occasionally echo clearly identified input metadata.
 * These keys contain no translated content, so removing only this allowlist is
 * safe while the strict schemas continue to reject every other extra property.
 */
function removeEchoedInputMetadata(value: unknown): unknown {
    if (!isRecord(value)) return value;

    const normalized = { ...value };
    delete normalized.market;
    delete normalized.sourceLanguage;

    if (Array.isArray(normalized.reviews)) {
        normalized.reviews = normalized.reviews.map(review => {
            if (!isRecord(review)) return review;
            const normalizedReview = { ...review };
            delete normalizedReview.market;
            delete normalizedReview.sourceLanguage;
            return normalizedReview;
        });
    }

    return normalized;
}

function parseJson(content: string, providerName: string): unknown {
    try {
        return removeEchoedInputMetadata(JSON.parse(content));
    } catch {
        throw new TranslationValidationError(
            `${providerName} returned translation content that was not valid JSON`
        );
    }
}

function requireNonEmptyTranslation(source: string, translation: string, path: string): void {
    if (source.trim() !== "" && translation.trim() === "") {
        throw new TranslationValidationError(`${path} is empty for non-empty source text`);
    }
}

function validateListingTranslations(
    source: { title: string; productFeatures: string[]; description: string },
    translations: ListingEnglishTranslations,
    path: string
): void {
    if (translations.productFeatures.length !== source.productFeatures.length) {
        throw new TranslationValidationError(
            `${path}.productFeatures has ${translations.productFeatures.length} items; expected ${source.productFeatures.length}`
        );
    }

    requireNonEmptyTranslation(source.title, translations.title, `${path}.title`);
    requireNonEmptyTranslation(source.description, translations.description, `${path}.description`);
    source.productFeatures.forEach((feature, index) =>
        requireNonEmptyTranslation(
            feature,
            translations.productFeatures[index] ?? "",
            `${path}.productFeatures.${index}`
        )
    );
}

export function parseAndValidateListingEnglishTranslations(
    content: string,
    suggestions: ProductSuggestions,
    providerName: string
): ListingEnglishTranslations {
    const result = listingEnglishTranslationsSchema.safeParse(parseJson(content, providerName));
    if (!result.success) {
        throw new TranslationValidationError(
            `${providerName} returned invalid listing translations: ${formatZodError(result.error)}`
        );
    }

    validateListingTranslations(
        {
            title: suggestions.title.value,
            productFeatures: suggestions.productFeatures.value,
            description: suggestions.description.value
        },
        result.data,
        "translations"
    );
    return result.data;
}

export function parseAndValidateProductEnglishTranslations(
    content: string,
    product: ScrapedProduct,
    suggestions: ProductSuggestions,
    providerName: string
): ProductEnglishTranslations {
    const result = productEnglishTranslationsSchema.safeParse(parseJson(content, providerName));
    if (!result.success) {
        throw new TranslationValidationError(
            `${providerName} returned invalid product translations: ${formatZodError(result.error)}`
        );
    }

    validateListingTranslations(product, result.data.original, "original");
    validateListingTranslations(
        {
            title: suggestions.title.value,
            productFeatures: suggestions.productFeatures.value,
            description: suggestions.description.value
        },
        result.data.suggestions,
        "suggestions"
    );

    if (result.data.reviews.length !== product.reviews.items.length) {
        throw new TranslationValidationError(
            `reviews has ${result.data.reviews.length} items; expected ${product.reviews.items.length}`
        );
    }

    product.reviews.items.forEach((review, index) => {
        const translation = result.data.reviews[index];
        if (
            translation.index !== index ||
            translation.reviewKey !== `${index}:${review.id ?? "no-id"}`
        ) {
            throw new TranslationValidationError(
                `reviews.${index} does not preserve its index or reviewKey`
            );
        }

        requireNonEmptyTranslation(review.title ?? "", translation.title, `reviews.${index}.title`);
        requireNonEmptyTranslation(review.comment, translation.comment, `reviews.${index}.comment`);
        requireNonEmptyTranslation(review.dateText, translation.dateText, `reviews.${index}.dateText`);
        requireNonEmptyTranslation(
            review.variant ?? "",
            translation.variant,
            `reviews.${index}.variant`
        );
    });

    return result.data;
}
