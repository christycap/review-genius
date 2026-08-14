import { ZodError } from "zod";
import { AMAZON_TITLE_CHARACTER_LIMIT } from "./prompts/product-optimization.js";
import { suggestionsSchema, type ProductSuggestions, type ScrapedProduct } from "./schemas.js";

const COMPLACENT_REASONING_PATTERNS = [
    /\bno (?:material )?changes? (?:are |were )?(?:needed|required)\b/i,
    /\b(?:kept|left|leave) .{0,50} as[- ]is\b/i,
    /\balready (?:clear|concise|effective|optimized|optimal|strong|well[- ](?:structured|written|optimized))\b/i
];

export class SuggestionValidationError extends Error {}

function formatZodError(error: ZodError): string {
    return error.issues
        .map(issue => `${issue.path.length === 0 ? "response" : issue.path.join(".")}: ${issue.message}`)
        .join("; ");
}

function normalizeText(value: string): string {
    return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function parseSuggestions(content: string): ProductSuggestions {
    if (content.trim() === "") {
        throw new SuggestionValidationError("returned an empty response");
    }

    let value: unknown;
    try {
        value = JSON.parse(content);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new SuggestionValidationError(`returned invalid JSON: ${message}`);
    }

    const result = suggestionsSchema.safeParse(value);
    if (!result.success) {
        throw new SuggestionValidationError(
            `returned suggestions in an invalid shape: ${formatZodError(result.error)}`
        );
    }

    return result.data;
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
        throw new SuggestionValidationError(
            `did not produce a compliant optimization: ${issues.join("; ")}`
        );
    }
}

export function parseAndValidateSuggestions(
    content: string,
    product: ScrapedProduct
): ProductSuggestions {
    const suggestions = parseSuggestions(content);
    validateSuggestions(product, suggestions);
    return suggestions;
}
