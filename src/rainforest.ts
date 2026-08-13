import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Input, OutputProduct } from "./schemas.js";

const API_URL = "https://api.rainforestapi.com/request";
const CACHE_DIRECTORY = path.resolve(".cache/rainforest");
const MAX_ATTEMPTS = 4;
const MAX_REVIEW_PAGES = 10;

const amazonDomains: Record<Input["market"], string> = {
    fr: "amazon.fr",
    it: "amazon.it",
    es: "amazon.es"
};

type JsonObject = Record<string, unknown>;

export class RainforestError extends Error {}

const isObject = (value: unknown): value is JsonObject =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const delay = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));

async function readCached(cachePath: string): Promise<unknown | undefined> {
    try {
        return JSON.parse(await readFile(cachePath, "utf8"));
    } catch (error) {
        const code = isObject(error) && typeof error.code === "string" ? error.code : undefined;

        if (code === "ENOENT") {
            return undefined;
        }

        throw error;
    }
}

async function request(
    apiKey: string,
    parameters: Record<string, string>,
    useCache = true
): Promise<JsonObject> {
    const cacheKey = createHash("sha256")
        .update(JSON.stringify(Object.entries(parameters).sort()))
        .digest("hex");
    const cachePath = path.join(CACHE_DIRECTORY, `${cacheKey}.json`);
    const cached = useCache ? await readCached(cachePath) : undefined;

    if (isObject(cached)) {
        return cached;
    }

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        const query = new URLSearchParams({ ...parameters, api_key: apiKey, output: "json" });
        const response = await fetch(`${API_URL}?${query}`, {
            signal: AbortSignal.timeout(90_000)
        });
        const body: unknown = await response.json().catch(() => undefined);
        const requestInfo =
            isObject(body) && isObject(body.request_info) ? body.request_info : undefined;
        const success = requestInfo?.success === true;

        if (response.ok && success && isObject(body)) {
            await mkdir(CACHE_DIRECTORY, { recursive: true });
            await writeFile(cachePath, `${JSON.stringify(body, null, 2)}\n`);
            return body;
        }

        const message =
            typeof requestInfo?.message === "string"
                ? requestInfo.message
                : `Rainforest returned HTTP ${response.status}`;
        const isTransient = response.status === 429 || response.status >= 500;

        if (!isTransient || attempt === MAX_ATTEMPTS) {
            throw new RainforestError(message);
        }

        const waitMilliseconds = 1_000 * 2 ** (attempt - 1);
        console.warn(`    Temporary Rainforest error: ${message}. Retrying in ${waitMilliseconds}ms...`);
        await delay(waitMilliseconds);
    }

    throw new RainforestError("Rainforest request failed unexpectedly");
}

function stringArray(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return value.filter((item): item is string => typeof item === "string").map(item => item.trim());
}

function extractDescription(product: JsonObject): string {
    if (typeof product.description === "string") {
        return product.description.trim();
    }

    const content = product.a_plus_content;
    const acceptedKeys = new Set(["text", "body", "description", "headline", "title"]);
    const parts: string[] = [];

    const visit = (value: unknown, key?: string): void => {
        if (typeof value === "string") {
            if (key && acceptedKeys.has(key) && value.trim()) {
                parts.push(value.trim());
            }
            return;
        }

        if (Array.isArray(value)) {
            value.forEach(item => visit(item, key));
            return;
        }

        if (isObject(value)) {
            Object.entries(value).forEach(([childKey, child]) => visit(child, childKey));
        }
    };

    visit(content);
    return [...new Set(parts)].join("\n\n");
}

function extractProduct(body: JsonObject, asin: string): Omit<OutputProduct, "reviews"> {
    if (!isObject(body.product)) {
        throw new RainforestError(`Rainforest returned no product data for ${asin}`);
    }

    const product = body.product;
    const mainImage = isObject(product.main_image) ? product.main_image : undefined;

    return {
        asin,
        title: typeof product.title === "string" ? product.title.trim() : "",
        productFeatures: stringArray(product.feature_bullets).filter(Boolean),
        description: extractDescription(product),
        productImageUrl: typeof mainImage?.link === "string" ? mainImage.link : ""
    };
}

function extractReviews(body: JsonObject): OutputProduct["reviews"] {
    if (!Array.isArray(body.reviews)) {
        return [];
    }

    return body.reviews.flatMap(review => {
        if (!isObject(review)) {
            return [];
        }

        const rating = review.rating;
        const comment =
            typeof review.body === "string"
                ? review.body.trim()
                : typeof review.comment === "string"
                ? review.comment.trim()
                : "";

        if (![1, 2, 3, 4, 5].includes(rating as number) || !comment) {
            return [];
        }

        return [{ rating: rating as 1 | 2 | 3 | 4 | 5, comment }];
    });
}

export async function fetchProduct(
    apiKey: string,
    market: Input["market"],
    asin: string
): Promise<OutputProduct> {
    const amazonDomain = amazonDomains[market];
    const productBody = await request(apiKey, {
        type: "product",
        amazon_domain: amazonDomain,
        asin
    });
    const product = extractProduct(productBody, asin);
    const reviews: OutputProduct["reviews"] = [];
    const seenReviews = new Set<string>();

    for (let page = 1; page <= MAX_REVIEW_PAGES && reviews.length < 20; page += 1) {
        const reviewBody = await request(
            apiKey,
            {
                type: "reviews",
                amazon_domain: amazonDomain,
                asin,
                sort_by: "most_recent",
                page: String(page)
            },
            false
        );
        const pageReviews = extractReviews(reviewBody);

        for (const review of pageReviews) {
            const identity = `${review.rating}\0${review.comment}`;
            if (!seenReviews.has(identity)) {
                reviews.push(review);
                seenReviews.add(identity);
            }
            if (reviews.length === 20) {
                break;
            }
        }

        if (pageReviews.length === 0) {
            break;
        }
    }

    return { ...product, reviews };
}
