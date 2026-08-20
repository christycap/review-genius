const AMAZON_RATING_PREFIX =
    /^[1-5](?:[.,]\d+)?\s+(?:out\s+of|sur|su|de|von|van)\s+5\s+(?:stars?|étoiles?|stelle|sternen?|estrellas?|sterren)\s*[-–—:]?\s*/iu;

export function stripAmazonRatingFromReviewTitle(title: string | null): string | null {
    if (title === null) return null;

    const strippedTitle = title.trim().replace(AMAZON_RATING_PREFIX, "").trim();
    return strippedTitle === "" ? null : strippedTitle;
}
