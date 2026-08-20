import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { load } from "cheerio";
import type { Page } from "puppeteer";
import { createAmazonPage, waitForAmazonAccess } from "./amazon-browser.js";
import { amazonMarketplaces } from "./amazon-marketplaces.js";
import { runExternalRequest } from "./external-request.js";
import { productReviewsSchema, type Market, type ProductReviews, type Review } from "./schemas.js";

export const AMAZON_REVIEW_LIMIT = 100;
export const AMAZON_REVIEW_SCRAPER_VERSION = 4;

const REVIEW_CACHE_DIRECTORY = path.resolve(".cache/amazon/reviews");
const REVIEW_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const RECENT_REVIEW_TARGET = 70;
const CRITICAL_REVIEW_TARGET = AMAZON_REVIEW_LIMIT - RECENT_REVIEW_TARGET;

type CollectionReason = "recent" | "critical";

type PageCollection = {
    items: Review[];
    pagesVisited: number;
    exhausted: boolean;
    firstPageHtml?: string;
};

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

function fold(value: string): string {
    return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

export function parseHelpfulVoteCount(value: string): number {
    const numeric = parseLocalizedInteger(value);
    if (numeric !== undefined) return numeric;

    const normalized = fold(cleanText(value));
    const singularMarkers = [
        "one person",
        "une personne",
        "una persona",
        "eine person",
        "ein kunde",
        "een persoon",
        "een klant"
    ];

    return singularMarkers.some(marker => normalized.includes(marker)) ? 1 : 0;
}

const monthNumbers = new Map<string, number>([
    ["january", 1],
    ["janvier", 1],
    ["gennaio", 1],
    ["enero", 1],
    ["januar", 1],
    ["januari", 1],
    ["february", 2],
    ["fevrier", 2],
    ["febbraio", 2],
    ["febrero", 2],
    ["februar", 2],
    ["februari", 2],
    ["march", 3],
    ["mars", 3],
    ["marzo", 3],
    ["marz", 3],
    ["maart", 3],
    ["april", 4],
    ["avril", 4],
    ["aprile", 4],
    ["abril", 4],
    ["may", 5],
    ["mai", 5],
    ["maggio", 5],
    ["mayo", 5],
    ["mei", 5],
    ["june", 6],
    ["juin", 6],
    ["giugno", 6],
    ["junio", 6],
    ["juni", 6],
    ["july", 7],
    ["juillet", 7],
    ["luglio", 7],
    ["julio", 7],
    ["juli", 7],
    ["august", 8],
    ["aout", 8],
    ["agosto", 8],
    ["augustus", 8],
    ["september", 9],
    ["septembre", 9],
    ["settembre", 9],
    ["septiembre", 9],
    ["october", 10],
    ["octobre", 10],
    ["ottobre", 10],
    ["octubre", 10],
    ["oktober", 10],
    ["november", 11],
    ["novembre", 11],
    ["noviembre", 11],
    ["december", 12],
    ["decembre", 12],
    ["dicembre", 12],
    ["diciembre", 12],
    ["dezember", 12]
]);

function toIsoDate(year: number, month: number, day: number): string | null {
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
        date.getUTCFullYear() !== year ||
        date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day
    ) {
        return null;
    }

    return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day
        .toString()
        .padStart(2, "0")}`;
}

function parseReviewDate(value: string): string | null {
    const normalized = fold(value);
    const monthNames = [...monthNumbers.keys()].sort((a, b) => b.length - a.length).join("|");
    const dayFirst = normalized.match(
        new RegExp(`(\\d{1,2})\\.?\\s+(?:de\\s+)?(${monthNames})\\s+(?:de\\s+)?(\\d{4})`)
    );

    if (dayFirst) {
        return toIsoDate(
            Number.parseInt(dayFirst[3], 10),
            monthNumbers.get(dayFirst[2])!,
            Number.parseInt(dayFirst[1], 10)
        );
    }

    const monthFirst = normalized.match(
        new RegExp(`(${monthNames})\\s+(\\d{1,2})(?:st|nd|rd|th)?[,]?\\s+(\\d{4})`)
    );
    if (!monthFirst) return null;

    return toIsoDate(
        Number.parseInt(monthFirst[3], 10),
        monthNumbers.get(monthFirst[1])!,
        Number.parseInt(monthFirst[2], 10)
    );
}

function extractReviewedAsin(hrefs: string[]): string | null {
    for (const href of hrefs) {
        const match = href.match(/\/(?:product-reviews|portal\/customer-reviews)\/([A-Z0-9]{10})/i);
        if (match) return match[1].toUpperCase();
    }

    return null;
}

function reviewIdentity(review: Review): string {
    return (
        review.id ??
        createHash("sha256")
            .update(
                JSON.stringify([
                    review.rating,
                    review.title,
                    review.comment,
                    review.date,
                    review.variant
                ])
            )
            .digest("hex")
    );
}

export function parseAmazonReviewItems(
    html: string,
    market: Market,
    reason: CollectionReason
): Review[] {
    const $ = load(html);
    const excludedCountries = amazonMarketplaces[market].excludedCountries;
    const selector = $('[data-hook="review"]').length
        ? '[data-hook="review"]'
        : '[data-hook="reviewContainer"]';
    const items: Review[] = [];
    const seen = new Set<string>();

    $(selector).each((_, element) => {
        const review = $(element);
        const dateText = cleanText(review.find('[data-hook="review-date"]').first().text());
        const foldedDate = fold(dateText);
        if (excludedCountries.some(country => foldedDate.includes(fold(country)))) return;

        const bodyElement = review
            .find(
                '[data-hook="reviewRichContentContainer"], .cr-lightbox-review-body, [data-hook="review-body"], [data-hook="reviewText"]'
            )
            .first();
        const body = cleanReviewText(bodyElement.text());
        const modernTitle = cleanReviewText(review.find('[data-hook="reviewTitle"]').first().text());
        const legacyTitleElement = review.find('[data-hook="review-title"], .review-title').first();
        const legacyTitle =
            cleanReviewText(legacyTitleElement.find("span").last().text()) ||
            cleanReviewText(legacyTitleElement.text());
        const ratingText = cleanText(
            review
                .find('[data-hook="review-star-rating"], [data-hook="cmps-review-star-rating"]')
                .first()
                .text()
        );
        const ratingMatch = ratingText.match(/[1-5](?:[.,]0)?/);
        const rating = ratingMatch ? Number.parseInt(ratingMatch[0], 10) : undefined;

        if (!body || rating === undefined || rating < 1 || rating > 5) return;

        const id =
            review.attr("data-reviewid") ?? review.attr("data-review-id") ?? review.attr("id") ?? null;
        const hrefs = review
            .find("a[href]")
            .map((_, link) => $(link).attr("href") ?? "")
            .get();
        const sourceLanguage =
            review.attr("data-sourcelanguage") ??
            bodyElement.attr("lang") ??
            review.find("[lang]").first().attr("lang") ??
            null;
        const variant = cleanText(review.find('[data-hook="format-strip"]').first().text()) || null;
        const helpfulElement = review
            .find('[data-hook="helpful-vote-statement"], .cr-vote-text')
            .first();
        const helpfulText = helpfulElement.attr("aria-label") ?? helpfulElement.text();
        const item: Review = {
            id,
            rating: rating as Review["rating"],
            title: modernTitle || legacyTitle || null,
            comment: body,
            date: parseReviewDate(dateText),
            dateText,
            verifiedPurchase: review.find('[data-hook="avp-badge"]').length > 0,
            reviewedAsin: extractReviewedAsin(hrefs),
            variant,
            sourceLanguage,
            helpfulCount: parseHelpfulVoteCount(helpfulText),
            selectionReason: reason
        };
        const identity = reviewIdentity(item);
        if (seen.has(identity)) return;

        seen.add(identity);
        items.push(item);
    });

    return items;
}

function parseAggregateReviews(
    html: string,
    fallback: Pick<ProductReviews, "overallRating" | "totalCount">
): Pick<ProductReviews, "overallRating" | "totalCount"> {
    const $ = load(html);
    const ratingText = cleanText(
        $('[data-hook="rating-out-of-text"], #acrPopover, .averageStarRatingNumerical')
            .first()
            .attr("title") ??
            $('[data-hook="rating-out-of-text"], #acrPopover, .averageStarRatingNumerical')
                .first()
                .text()
    );
    const countElement = $('[data-hook="total-review-count"], #acrCustomerReviewText').first();
    const countText = countElement.attr("aria-label") ?? cleanText(countElement.text());
    const overallRating = parseLocalizedNumber(ratingText) ?? fallback.overallRating;
    const totalCount = parseLocalizedInteger(countText) ?? fallback.totalCount;

    return {
        overallRating: overallRating >= 0 && overallRating <= 5 ? overallRating : fallback.overallRating,
        totalCount: totalCount >= 0 ? totalCount : fallback.totalCount
    };
}

function explicitlyHasNoWrittenReviews(html: string): boolean {
    const $ = load(html);
    if ($('[data-hook="no-reviews-message"], .no-reviews-section').length > 0) return true;

    const text = fold($("body").text());
    return [
        "no customer reviews",
        "aucun commentaire client",
        "non ci sono recensioni",
        "no hay resenas",
        "noch keine kundenrezensionen",
        "geen klantenrecensies"
    ].some(message => text.includes(message));
}

function findNextPageUrl(html: string, currentUrl: string): string | undefined {
    const $ = load(html);
    const href =
        $("li.a-last:not(.a-disabled) a[href]").first().attr("href") ??
        $('[data-hook="pagination-bar"] a[data-hook="pagination-next"][href]').first().attr("href") ??
        $('a[data-hook="pagination-next"][href]').first().attr("href");
    if (!href) return undefined;

    return new URL(href, currentUrl).href;
}

function buildNumberedNextPageUrl(currentUrl: string, currentPage: number): string {
    const url = new URL(currentUrl);
    url.searchParams.set("pageNumber", (currentPage + 1).toString());
    return url.href;
}

async function writePageCache(
    market: Market,
    asin: string,
    label: string,
    pageNumber: number,
    html: string
): Promise<void> {
    const directory = path.join(REVIEW_CACHE_DIRECTORY, market, asin);
    await mkdir(directory, { recursive: true });
    await writeFile(
        path.join(directory, `${label}-page-${pageNumber.toString().padStart(2, "0")}.html`),
        html
    );
}

async function collectPages(
    page: Page,
    market: Market,
    asin: string,
    initialUrl: string,
    reason: CollectionReason,
    maximumItems: number,
    cacheLabel: string
): Promise<PageCollection> {
    const items: Review[] = [];
    const seenItems = new Set<string>();
    const visitedUrls = new Set<string>();
    let nextUrl: string | undefined = initialUrl;
    let pagesVisited = 0;
    let exhausted = false;
    let firstPageHtml: string | undefined;

    while (nextUrl && items.length < maximumItems) {
        if (visitedUrls.has(nextUrl)) {
            exhausted = true;
            break;
        }
        visitedUrls.add(nextUrl);

        const response = await page.goto(nextUrl, { waitUntil: "domcontentloaded" });
        await waitForAmazonAccess(page, market, asin);
        if (response && !response.ok() && page.url() === response.url()) {
            throw new Error(`Amazon returned HTTP ${response.status()} for its review page`);
        }

        await page
            .waitForSelector(
                '[data-hook="review"], [data-hook="reviewContainer"], [data-hook="no-reviews-message"]',
                { timeout: 10_000 }
            )
            .catch(() => undefined);
        const html = await page.content();
        pagesVisited += 1;
        firstPageHtml ??= html;
        await writePageCache(market, asin, cacheLabel, pagesVisited, html);

        const parsed = parseAmazonReviewItems(html, market, reason);
        let newItems = 0;
        for (const review of parsed) {
            const identity = reviewIdentity(review);
            if (seenItems.has(identity)) continue;
            seenItems.add(identity);
            items.push(review);
            newItems += 1;
            if (items.length === maximumItems) break;
        }

        const candidateNextUrl =
            findNextPageUrl(html, page.url()) ??
            (parsed.length >= 8 ? buildNumberedNextPageUrl(page.url(), pagesVisited) : undefined);
        if (!candidateNextUrl || newItems === 0) {
            exhausted = true;
            break;
        }
        nextUrl = candidateNextUrl;
    }

    return { items, pagesVisited, exhausted, firstPageHtml };
}

export function createAmazonReviewUrl(productHtml: string, market: Market, asin: string): URL {
    const marketplace = amazonMarketplaces[market];
    const $ = load(productHtml);
    const seeAllHref =
        $("#cm_cr_top_reviews_to_arp_button").first().attr("href") ??
        $("#reviews-medley-footer a[href]").first().attr("href") ??
        $('[data-hook="see-all-reviews-link-foot"]').first().attr("href");
    const portalHref =
        seeAllHref ?? $(`a[href*="/portal/customer-reviews/${asin}"]`).first().attr("href");
    const classicHref = $(`a[href*="/product-reviews/${asin}"]`).first().attr("href");
    const fallback = `https://www.${marketplace.domain}/portal/customer-reviews/${asin}`;
    const url = new URL(portalHref ?? classicHref ?? fallback, `https://www.${marketplace.domain}`);

    url.hash = "";
    url.searchParams.delete("filterByStar");
    url.searchParams.set("reviewerType", "all_reviews");
    url.searchParams.set("sortBy", "recent");
    return url;
}

function withStarFilter(url: URL, filter: string): string {
    const filtered = new URL(url);
    filtered.searchParams.set("filterByStar", filter);
    filtered.searchParams.set("sortBy", "recent");
    return filtered.href;
}

function deduplicate(items: Review[]): Review[] {
    const seen = new Set<string>();
    return items.filter(item => {
        const identity = reviewIdentity(item);
        if (seen.has(identity)) return false;
        seen.add(identity);
        return true;
    });
}

function sortNewestFirst(items: Review[]): Review[] {
    return [...items].sort((left, right) => {
        if (left.date === right.date) return 0;
        if (left.date === null) return 1;
        if (right.date === null) return -1;
        return right.date.localeCompare(left.date);
    });
}

export function selectBalancedReviews(
    recent: Review[],
    critical: Review[],
    embedded: Review[]
): Review[] {
    const selected: Review[] = [];
    const seen = new Set<string>();

    const add = (review: Review, selectionReason: Review["selectionReason"]): void => {
        if (selected.length >= AMAZON_REVIEW_LIMIT) return;
        const identity = reviewIdentity(review);
        if (seen.has(identity)) return;
        seen.add(identity);
        selected.push({ ...review, selectionReason });
    };

    recent.slice(0, RECENT_REVIEW_TARGET).forEach(review => add(review, "recent"));
    critical
        .filter(review => review.rating <= 3)
        .slice(0, CRITICAL_REVIEW_TARGET)
        .forEach(review => add(review, "critical"));
    recent.slice(RECENT_REVIEW_TARGET).forEach(review => add(review, "recent"));
    critical.filter(review => review.rating <= 3).forEach(review => add(review, "critical"));
    embedded.forEach(review => add(review, "embedded-top"));

    return selected;
}

export function createReviewCorpusHash(
    reviews: Pick<ProductReviews, "overallRating" | "totalCount" | "items">
): string {
    return createHash("sha256")
        .update(
            JSON.stringify({
                overallRating: reviews.overallRating,
                totalCount: reviews.totalCount,
                items: reviews.items.map(review => ({
                    id: review.id,
                    rating: review.rating,
                    title: review.title,
                    comment: review.comment,
                    date: review.date,
                    verifiedPurchase: review.verifiedPurchase,
                    reviewedAsin: review.reviewedAsin,
                    variant: review.variant,
                    sourceLanguage: review.sourceLanguage,
                    helpfulCount: review.helpfulCount,
                    selectionReason: review.selectionReason
                }))
            })
        )
        .digest("hex");
}

export function isReviewCollectionCurrent(reviews: ProductReviews, now = Date.now()): boolean {
    if (
        reviews.collection.scraperVersion !== AMAZON_REVIEW_SCRAPER_VERSION ||
        reviews.collection.strategy !== "recent-balanced" ||
        reviews.collection.limit !== AMAZON_REVIEW_LIMIT ||
        !reviews.collection.complete ||
        reviews.collection.collectedAt === null ||
        reviews.collection.corpusHash === null
    ) {
        return false;
    }

    const collectedAt = Date.parse(reviews.collection.collectedAt);
    return (
        Number.isFinite(collectedAt) &&
        collectedAt <= now + 5 * 60_000 &&
        now - collectedAt <= REVIEW_CACHE_TTL_MS
    );
}

async function readReviewCache(market: Market, asin: string): Promise<ProductReviews | undefined> {
    const cachePath = path.join(REVIEW_CACHE_DIRECTORY, market, asin, "reviews.json");
    try {
        const value: unknown = JSON.parse(await readFile(cachePath, "utf8"));
        const result = productReviewsSchema.safeParse(value);
        if (result.success && isReviewCollectionCurrent(result.data)) return result.data;
        return undefined;
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
        if (error instanceof SyntaxError) return undefined;
        throw error;
    }
}

async function writeReviewCache(market: Market, asin: string, reviews: ProductReviews): Promise<void> {
    const directory = path.join(REVIEW_CACHE_DIRECTORY, market, asin);
    const cachePath = path.join(directory, "reviews.json");
    const temporaryPath = `${cachePath}.tmp`;
    await mkdir(directory, { recursive: true });
    await writeFile(temporaryPath, `${JSON.stringify(reviews, null, 4)}\n`);
    await rename(temporaryPath, cachePath);
}

async function scrapeReviews(
    market: Market,
    asin: string,
    productHtml: string,
    fallback: ProductReviews
): Promise<ProductReviews> {
    const collectedAt = new Date();

    if (fallback.totalCount === 0) {
        const emptyReviews: ProductReviews = {
            overallRating: fallback.overallRating,
            totalCount: 0,
            items: [],
            collection: {
                strategy: "recent-balanced",
                limit: AMAZON_REVIEW_LIMIT,
                collectedAt: collectedAt.toISOString(),
                pagesVisited: 0,
                complete: true,
                scraperVersion: AMAZON_REVIEW_SCRAPER_VERSION,
                corpusHash: null
            }
        };
        emptyReviews.collection.corpusHash = createReviewCorpusHash(emptyReviews);
        return emptyReviews;
    }

    const baseUrl = createAmazonReviewUrl(productHtml, market, asin);
    const page = await createAmazonPage(market);

    try {
        console.log(`    Collecting up to ${AMAZON_REVIEW_LIMIT} recent and critical Amazon reviews...`);
        const recent = await collectPages(
            page,
            market,
            asin,
            baseUrl.href,
            "recent",
            AMAZON_REVIEW_LIMIT,
            "recent"
        );

        if (recent.items.length === 0) {
            if (explicitlyHasNoWrittenReviews(recent.firstPageHtml ?? "")) {
                const aggregate = parseAggregateReviews(recent.firstPageHtml ?? "", fallback);
                const noWrittenReviews: ProductReviews = {
                    ...aggregate,
                    items: [],
                    collection: {
                        strategy: "recent-balanced",
                        limit: AMAZON_REVIEW_LIMIT,
                        collectedAt: collectedAt.toISOString(),
                        pagesVisited: recent.pagesVisited,
                        complete: true,
                        scraperVersion: AMAZON_REVIEW_SCRAPER_VERSION,
                        corpusHash: null
                    }
                };
                noWrittenReviews.collection.corpusHash = createReviewCorpusHash(noWrittenReviews);
                return noWrittenReviews;
            }

            throw new Error(
                "Amazon returned no readable recent reviews even though the listing reports reviews"
            );
        }

        let critical = await collectPages(
            page,
            market,
            asin,
            withStarFilter(baseUrl, "critical"),
            "critical",
            CRITICAL_REVIEW_TARGET,
            "critical"
        );

        if (critical.items.filter(review => review.rating <= 3).length < CRITICAL_REVIEW_TARGET) {
            const starFilters = ["one_star", "two_star", "three_star"];
            const starCollections: PageCollection[] = [];

            for (const filter of starFilters) {
                starCollections.push(
                    await collectPages(
                        page,
                        market,
                        asin,
                        withStarFilter(baseUrl, filter),
                        "critical",
                        CRITICAL_REVIEW_TARGET,
                        filter
                    )
                );
            }

            critical = {
                items: sortNewestFirst(
                    deduplicate([
                        ...critical.items,
                        ...starCollections.flatMap(collection => collection.items)
                    ])
                ),
                pagesVisited:
                    critical.pagesVisited +
                    starCollections.reduce((total, collection) => total + collection.pagesVisited, 0),
                exhausted:
                    critical.exhausted && starCollections.every(collection => collection.exhausted)
            };
        }

        const aggregate = parseAggregateReviews(recent.firstPageHtml ?? "", fallback);
        const items = selectBalancedReviews(recent.items, critical.items, fallback.items);
        const reviews: ProductReviews = {
            ...aggregate,
            items,
            collection: {
                strategy: "recent-balanced",
                limit: AMAZON_REVIEW_LIMIT,
                collectedAt: collectedAt.toISOString(),
                pagesVisited: recent.pagesVisited + critical.pagesVisited,
                complete: true,
                scraperVersion: AMAZON_REVIEW_SCRAPER_VERSION,
                corpusHash: null
            }
        };
        reviews.collection.corpusHash = createReviewCorpusHash(reviews);
        console.log(
            `    Collected ${items.length} reviews (${
                items.filter(item => item.selectionReason === "critical").length
            } added for critical coverage) across ${reviews.collection.pagesVisited} page(s)`
        );
        return reviews;
    } finally {
        await page.close().catch(() => undefined);
    }
}

export async function collectAmazonReviews(
    market: Market,
    asin: string,
    productHtml: string,
    fallback: ProductReviews
): Promise<ProductReviews> {
    const cached = await readReviewCache(market, asin);
    if (cached) {
        console.log("    Using cached recent Amazon reviews");
        return cached;
    }

    const reviews = await runExternalRequest(() => scrapeReviews(market, asin, productHtml, fallback));
    await writeReviewCache(market, asin, reviews);
    return reviews;
}
