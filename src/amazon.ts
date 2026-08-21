import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { load } from "cheerio";
import { createAmazonPage, waitForAmazonAccess } from "./amazon-browser.js";
import { amazonMarketplaces, getAmazonProductUrl } from "./amazon-marketplaces.js";
import { collectAmazonReviews, parseHelpfulVoteCount } from "./amazon-reviews.js";
import { runExternalRequest } from "./external-request.js";
import { stripAmazonRatingFromReviewTitle } from "./review-title.js";
import type { Market, ScrapedProduct } from "./schemas.js";

const CACHE_DIRECTORY = path.resolve(".cache/amazon");
const MAX_ATTEMPTS = 3;

export class AmazonScrapingError extends Error {}

const delay = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds));

function cleanText(value: string): string {
    return value.replace(/\s+/g, " ").trim();
}

function cleanReviewText(value: string): string {
    let cleaned = cleanText(value)
        .replace(/Brief content visible, double tap to read full content\./gi, "")
        .replace(/Full content visible, double tap to read brief content\./gi, "");

    const trailingControlLabel =
        /\s*(?:Read more|Show less|See more|See less|Lire la suite|Afficher plus|Afficher moins|Visualizza altro|Mostra altro|Mostra meno|Leer más|Ver más|Mostrar menos)\s*$/i;

    while (trailingControlLabel.test(cleaned)) {
        cleaned = cleaned.replace(trailingControlLabel, "");
    }

    return cleanText(cleaned);
}

function parseLocalizedNumber(value: string): number | undefined {
    const match = cleanText(value).match(/\d+(?:[.,]\d+)?/);
    if (!match) return undefined;

    const parsed = Number.parseFloat(match[0].replace(",", "."));
    return Number.isFinite(parsed) ? parsed : undefined;
}

function parseLocalizedInteger(value: string): number | undefined {
    const digits = value.replace(/\D/g, "");
    if (!digits) return undefined;

    const parsed = Number.parseInt(digits, 10);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function looksLikeAmazonPage(html: string): boolean {
    const folded = html.toLowerCase();
    return (
        html.length >= 20_000 &&
        !folded.includes("api-services-support@amazon.com") &&
        !folded.includes("enter the characters you see below") &&
        !folded.includes("saisissez les caractères que vous voyez ci-dessous") &&
        !folded.includes("inserisci i caratteri che vedi qui sotto") &&
        !folded.includes("introduce los caracteres que aparecen a continuación") &&
        !folded.includes("geben sie die zeichen ein, die sie unten sehen") &&
        !folded.includes("voer de tekens in die u hieronder ziet")
    );
}

async function readCachedHtml(cachePath: string): Promise<string | undefined> {
    try {
        return await readFile(cachePath, "utf8");
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return undefined;
        }
        throw error;
    }
}

async function fetchHtml(market: Market, asin: string): Promise<string> {
    const marketplace = amazonMarketplaces[market];
    const cachePath = path.join(CACHE_DIRECTORY, market, `${asin}.html`);
    const cached = await readCachedHtml(cachePath);

    if (cached !== undefined) {
        console.log("    Using cached Amazon page");
        return cached;
    }

    const url = getAmazonProductUrl(market, asin);

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
        try {
            const { response, html } = await runExternalRequest(async () => {
                const response = await fetch(url, {
                    headers: {
                        "user-agent":
                            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
                            "(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36",
                        "accept-language": marketplace.language,
                        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8"
                    },
                    redirect: "follow",
                    signal: AbortSignal.timeout(30_000)
                });

                return { response, html: await response.text() };
            });

            if (!response.ok) {
                throw new AmazonScrapingError(`Amazon returned HTTP ${response.status}`);
            }
            if (!looksLikeAmazonPage(html)) {
                throw new AmazonScrapingError("Amazon returned a challenge or incomplete page");
            }

            await mkdir(path.dirname(cachePath), { recursive: true });
            await writeFile(cachePath, html);
            return html;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (attempt === MAX_ATTEMPTS) break;

            const waitMilliseconds = 1_000 * 2 ** (attempt - 1);
            console.warn(`    Amazon request failed: ${message}. Retrying in ${waitMilliseconds}ms...`);
            await delay(waitMilliseconds);
        }
    }

    console.warn("    Direct Amazon fetch failed; retrying in the authenticated browser...");
    return runExternalRequest(async () => {
        const page = await createAmazonPage(market);

        try {
            const response = await page.goto(url, { waitUntil: "domcontentloaded" });
            await waitForAmazonAccess(page, market, asin);
            if (response && !response.ok() && page.url() === response.url()) {
                throw new AmazonScrapingError(`Amazon returned HTTP ${response.status()}`);
            }
            const html = await page.content();
            if (!looksLikeAmazonPage(html)) {
                throw new AmazonScrapingError(
                    "Amazon returned a challenge or incomplete product page in the browser"
                );
            }

            await mkdir(path.dirname(cachePath), { recursive: true });
            await writeFile(cachePath, html);
            return html;
        } finally {
            await page.close().catch(() => undefined);
        }
    });
}

function extractImageUrl(attributes: Record<string, string | undefined>): string {
    if (attributes["data-old-hires"]) {
        return attributes["data-old-hires"];
    }

    const dynamicImage = attributes["data-a-dynamic-image"];
    if (dynamicImage) {
        try {
            const images: unknown = JSON.parse(dynamicImage);
            if (typeof images === "object" && images !== null && !Array.isArray(images)) {
                return Object.keys(images)[0] ?? "";
            }
        } catch {
            // Fall back to the normal src attribute.
        }
    }

    return attributes.src ?? "";
}

function parseProduct(html: string, market: Market, asin: string): ScrapedProduct {
    const $ = load(html);
    const title = cleanText($("#productTitle").first().text()) || cleanText($("title").first().text());

    if (!title) {
        throw new AmazonScrapingError(`Could not extract a product title for ${market}/${asin}`);
    }

    const productFeatures = $("#feature-bullets li span.a-list-item")
        .map((_, element) => cleanText($(element).text()))
        .get()
        .filter((feature, index, features) => feature !== "" && features.indexOf(feature) === index);
    const descriptionSelectors = [
        "#productDescription",
        "#pqv-description",
        "#aplus_feature_div .aplus-v2",
        "#aplus_feature_div"
    ];
    const description =
        descriptionSelectors
            .map(selector => cleanText($(selector).first().text()))
            .find(value => value !== "") ?? "";
    const image = $("#landingImage").first();
    const productImageUrl = extractImageUrl({
        "data-old-hires": image.attr("data-old-hires"),
        "data-a-dynamic-image": image.attr("data-a-dynamic-image"),
        src: image.attr("src")
    });
    const excludedCountries = amazonMarketplaces[market].excludedCountries;
    const seenReviews = new Set<string>();
    const ratingText =
        $("#acrPopover").first().attr("title") ??
        cleanText($("#averageCustomerReviews .a-icon-alt").first().text());
    const countElement = $("#acrCustomerReviewText").first();
    const countText = countElement.attr("aria-label") ?? cleanText(countElement.text());
    const overallRating = parseLocalizedNumber(ratingText);
    const totalCount = parseLocalizedInteger(countText);

    if ((overallRating === undefined) !== (totalCount === undefined)) {
        throw new AmazonScrapingError(
            `Could not extract a complete aggregate review summary for ${market}/${asin}`
        );
    }
    if (overallRating !== undefined && (overallRating < 0 || overallRating > 5)) {
        throw new AmazonScrapingError(
            `Amazon returned an invalid aggregate rating for ${market}/${asin}: ${overallRating}`
        );
    }

    const reviewItems: ScrapedProduct["reviews"]["items"] = [];

    $('[data-hook="review"]').each((_, element) => {
        const review = $(element);
        const dateText = cleanText(
            review.find('[data-hook="review-date"]').first().text()
        ).toLowerCase();
        if (excludedCountries.some(country => dateText.includes(country))) {
            return;
        }

        const body =
            [
                '[data-hook="reviewRichContentContainer"]',
                ".cr-lightbox-review-body",
                '[data-hook="review-body"]',
                '[data-hook="reviewText"]'
            ]
                .map(selector => cleanReviewText(review.find(selector).first().text()))
                .find(value => value !== "") ?? "";
        const modernTitle = cleanReviewText(review.find('[data-hook="reviewTitle"]').first().text());
        const legacyTitleElement = review.find('[data-hook="review-title"], .review-title').first();
        const legacyTitle =
            cleanReviewText(legacyTitleElement.find("span").last().text()) ||
            cleanReviewText(legacyTitleElement.text());
        const title = stripAmazonRatingFromReviewTitle(modernTitle || legacyTitle || null);
        const ratingText = cleanText(
            review
                .find('[data-hook="review-star-rating"], [data-hook="cmps-review-star-rating"]')
                .first()
                .text()
        );
        const ratingMatch = ratingText.match(/[1-5](?:[.,]0)?/);
        const rating = ratingMatch ? Number.parseInt(ratingMatch[0], 10) : undefined;
        const identity = `${rating}\0${body}`;

        if (!body || rating === undefined || rating < 1 || rating > 5 || seenReviews.has(identity)) {
            return;
        }

        reviewItems.push({
            id: review.attr("id") ?? null,
            rating: rating as 1 | 2 | 3 | 4 | 5,
            title,
            comment: body,
            date: null,
            dateText,
            verifiedPurchase: review.find('[data-hook="avp-badge"]').length > 0,
            reviewedAsin: null,
            variant: cleanText(review.find('[data-hook="format-strip"]').first().text()) || null,
            sourceLanguage:
                review.attr("data-sourcelanguage") ?? review.find("[lang]").first().attr("lang") ?? null,
            helpfulCount: parseHelpfulVoteCount(
                review
                    .find('[data-hook="helpful-vote-statement"], .cr-vote-text')
                    .first()
                    .attr("aria-label") ??
                    review.find('[data-hook="helpful-vote-statement"], .cr-vote-text').first().text()
            ),
            selectionReason: "embedded-top"
        });
        seenReviews.add(identity);
    });

    const reviews: ScrapedProduct["reviews"] = {
        overallRating: overallRating ?? 0,
        totalCount: totalCount ?? 0,
        items: reviewItems,
        collection: {
            strategy: "embedded-top",
            limit: 30,
            collectedAt: null,
            pagesVisited: 0,
            complete: false,
            scraperVersion: 1,
            corpusHash: null
        }
    };

    return { asin, title, productFeatures, description, productImageUrl, reviews };
}

export async function fetchProduct(market: Market, asin: string): Promise<ScrapedProduct> {
    const html = await fetchHtml(market, asin);
    const product = parseProduct(html, market, asin);
    const reviews = await collectAmazonReviews(market, asin, html, product.reviews);
    return { ...product, reviews };
}
