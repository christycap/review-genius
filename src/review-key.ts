export function createReviewKey(review: { id: string | null }, index: number): string {
    return `${index}:${review.id ?? "no-id"}`;
}
