export const AMAZON_REVIEW_LIMIT = 70;

// Stored outputs produced by older scraper versions may contain up to 100 reviews.
// Schemas continue to accept them so the build can load and refresh those products.
export const LEGACY_REVIEW_STORAGE_LIMIT = 100;
