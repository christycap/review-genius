import {
    AlertCircle,
    ArrowRight,
    BarChart3,
    Check,
    ChevronRight,
    Clipboard,
    ExternalLink,
    FileText,
    Lightbulb,
    ListChecks,
    LoaderCircle,
    Languages,
    MessageSquarePlus,
    Moon,
    RotateCcw,
    Search,
    Sparkles,
    Star,
    Sun,
    Tag,
    ThumbsDown,
    ThumbsUp,
    UsersRound
} from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { ReportAiConfig } from "../ai.js";
import { PRODUCT_OPTIMIZATION_PROMPT_VERSION } from "../prompts/product-optimization.js";
import { createReviewKey } from "../review-key.js";
import {
    refinedSuggestionsSchema,
    SENTIMENT_PROMPT_VERSION,
    TRANSLATION_PROMPT_VERSION,
    type ListingEnglishTranslations,
    type Market,
    type ProductEnglishTranslations,
    type ProductReviews,
    type ProductSuggestions,
    type RefinedSuggestions,
    type Review,
    type ReviewSentiment,
    type ReviewSentimentAnalysis,
    type ScrapedProduct
} from "../schemas.js";
import { Badge } from "./components/ui/badge.js";
import { Button } from "./components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card.js";
import { Input } from "./components/ui/input.js";
import { Separator } from "./components/ui/separator.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs.js";
import { Textarea } from "./components/ui/textarea.js";
import { cn } from "./lib/utils.js";
import { regenerateSuggestions } from "./regenerate-suggestions.js";

type Product = ScrapedProduct & {
    suggestionPromptVersion?: number;
    suggestions?: ProductSuggestions;
    reviewSentiment?: ReviewSentimentAnalysis;
    englishTranslations?: ProductEnglishTranslations;
    displayedSuggestionEnglishTranslations?: ListingEnglishTranslations;
};
type ReportData = {
    title: string;
    markets: { market: Market; products: Product[] }[];
};

declare const __REPORT_DATA__: ReportData;
declare const __REPORT_AI_CONFIG__: ReportAiConfig;
declare const __REPORT_LOGO_URL__: string;

const { title: reportTitle, markets: reportData } = __REPORT_DATA__;
const reportAiConfig = __REPORT_AI_CONFIG__;
const REFINEMENT_STORAGE_KEY = [
    "review-genius-refinements",
    reportTitle,
    PRODUCT_OPTIMIZATION_PROMPT_VERSION,
    SENTIMENT_PROMPT_VERSION,
    TRANSLATION_PROMPT_VERSION,
    reportAiConfig.provider,
    reportAiConfig.model
].join(":");

type SuggestionOverrides = Record<string, RefinedSuggestions>;

function getProductKey(market: Market, asin: string): string {
    return `${market}/${asin}`;
}

function readSuggestionOverrides(): SuggestionOverrides {
    try {
        const value: unknown = JSON.parse(localStorage.getItem(REFINEMENT_STORAGE_KEY) ?? "{}");
        if (typeof value !== "object" || value === null || Array.isArray(value)) return {};

        return Object.fromEntries(
            Object.entries(value).flatMap(([key, refinement]) => {
                const result = refinedSuggestionsSchema.safeParse(refinement);
                return result.success ? [[key, result.data]] : [];
            })
        );
    } catch {
        return {};
    }
}

function writeSuggestionOverrides(overrides: SuggestionOverrides): void {
    try {
        if (Object.keys(overrides).length === 0) {
            localStorage.removeItem(REFINEMENT_STORAGE_KEY);
        } else {
            localStorage.setItem(REFINEMENT_STORAGE_KEY, JSON.stringify(overrides));
        }
    } catch {
        // The in-memory refinement still works when file:// storage is unavailable.
    }
}
const marketMetadata: Record<
    Market,
    { label: string; flag: string; domain: string; languageTag: string }
> = {
    fr: { label: "France", flag: "🇫🇷", domain: "amazon.fr", languageTag: "fr" },
    it: { label: "Italy", flag: "🇮🇹", domain: "amazon.it", languageTag: "it" },
    es: { label: "Spain", flag: "🇪🇸", domain: "amazon.es", languageTag: "es" },
    de: { label: "Germany", flag: "🇩🇪", domain: "amazon.de", languageTag: "de" },
    be: { label: "Belgium", flag: "🇧🇪", domain: "amazon.com.be", languageTag: "nl-BE" },
    nl: { label: "Netherlands", flag: "🇳🇱", domain: "amazon.nl", languageTag: "nl" }
};

function getHashSelection(): { market?: Market; asin?: string } {
    const [market, asin] = window.location.hash.replace(/^#\/?/, "").split("/");
    return { market: market as Market | undefined, asin };
}

function getInitialSelection(): { market: Market; asin: string } {
    const hash = getHashSelection();
    const group = reportData.find(item => item.market === hash.market) ?? reportData[0];
    const product = group?.products.find(item => item.asin === hash.asin) ?? group?.products[0];

    return { market: group?.market ?? "fr", asin: product?.asin ?? "" };
}

function navigate(market: Market, asin: string): void {
    const nextHash = `#/${market}/${asin}`;
    if (window.location.hash === nextHash) {
        window.dispatchEvent(new HashChangeEvent("hashchange"));
    } else {
        window.location.hash = nextHash;
    }
}

function RatingStars({ rating, size = "default" }: { rating: number; size?: "small" | "default" }) {
    const iconClassName = size === "small" ? "size-3" : "size-4";

    return (
        <span className="inline-flex items-center gap-0.5" aria-label={`${rating} out of 5 stars`}>
            {Array.from({ length: 5 }, (_, index) => {
                const fill = Math.max(0, Math.min(1, rating - index));

                return (
                    <span key={index} className={cn("relative shrink-0", iconClassName)}>
                        <Star
                            className={cn(
                                "absolute inset-0 fill-muted text-muted-foreground/25",
                                iconClassName
                            )}
                        />
                        {fill > 0 && (
                            <span
                                className="absolute inset-y-0 left-0 overflow-hidden"
                                style={{ width: `${fill * 100}%` }}
                            >
                                <Star
                                    className={cn(
                                        "absolute inset-y-0 left-0 max-w-none fill-amber-400 text-amber-400",
                                        iconClassName
                                    )}
                                />
                            </span>
                        )}
                    </span>
                );
            })}
        </span>
    );
}

function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
    const [copied, setCopied] = useState(false);

    async function copy(): Promise<void> {
        if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(value);
        } else {
            const textArea = document.createElement("textarea");
            textArea.value = value;
            textArea.style.position = "fixed";
            textArea.style.opacity = "0";
            document.body.append(textArea);
            textArea.select();
            document.execCommand("copy");
            textArea.remove();
        }

        setCopied(true);
        window.setTimeout(() => setCopied(false), 1_500);
    }

    return (
        <Button variant="ghost" size="icon" onClick={() => void copy()} title={label}>
            {copied ? <Check className="text-emerald-600" /> : <Clipboard />}
            <span className="sr-only">{label}</span>
        </Button>
    );
}

function EnglishTranslationReveal({
    children,
    className,
    buttonClassName
}: {
    children: React.ReactNode;
    className?: string;
    buttonClassName?: string;
}) {
    const [visible, setVisible] = useState(false);
    const translationId = useId();

    return (
        <div className="mt-3">
            <Button
                type="button"
                variant="ghost"
                size="sm"
                className={cn("h-7 px-2 text-xs text-muted-foreground", buttonClassName)}
                onClick={() => setVisible(value => !value)}
                aria-expanded={visible}
                aria-controls={translationId}
            >
                <Languages className="size-3.5" />
                {visible ? "Hide English translation" : "Show English translation"}
            </Button>
            {visible && (
                <div
                    id={translationId}
                    lang="en"
                    className={cn(
                        "mt-2 border-l-2 border-primary/25 pl-3 text-sm leading-6 text-muted-foreground italic",
                        className
                    )}
                >
                    {children}
                </div>
            )}
        </div>
    );
}

function countCharacters(value: string): number {
    return Array.from(value).length;
}

function CharacterMetrics({ count, originalCount }: { count: number; originalCount?: number }) {
    const difference = originalCount === undefined ? undefined : count - originalCount;

    return (
        <div className="flex items-center gap-1.5 font-mono text-[11px] tabular-nums">
            <Badge variant="outline" className="bg-background/70 font-mono text-muted-foreground">
                {count.toLocaleString("en")} chars
            </Badge>
            {difference !== undefined && (
                <Badge
                    variant="outline"
                    className={cn(
                        "font-mono",
                        difference < 0 &&
                            "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
                        difference > 0 &&
                            "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300",
                        difference === 0 && "bg-muted text-muted-foreground"
                    )}
                    title="Difference from the original"
                >
                    ({difference > 0 ? `+${difference}` : difference} chars)
                </Badge>
            )}
        </div>
    );
}

function Reasoning({ children }: { children: string }) {
    return (
        <div className="mt-5 flex gap-3 rounded-lg border border-primary/20 bg-primary/5 p-4 text-sm leading-6">
            <Lightbulb className="mt-0.5 size-4 shrink-0 text-primary" />
            <div>
                <p className="mb-1 font-semibold text-primary">Reasoning</p>
                <p lang="en" className="text-muted-foreground">
                    {children}
                </p>
            </div>
        </div>
    );
}

function ComparisonHeader({ icon, title }: { icon: React.ReactNode; title: string }) {
    return (
        <div className="flex items-center gap-2">
            <span className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                {icon}
            </span>
            <CardTitle>{title}</CardTitle>
        </div>
    );
}

function TitleComparison({ product, languageTag }: { product: Product; languageTag: string }) {
    const suggestion = product.suggestions?.title;
    if (!suggestion) return <PendingSuggestions />;

    return (
        <Card>
            <CardHeader>
                <ComparisonHeader icon={<Tag className="size-4" />} title="Product title" />
            </CardHeader>
            <CardContent>
                <div className="grid gap-4 lg:grid-cols-2">
                    <TextPanel
                        label="Current title"
                        languageTag={languageTag}
                        value={product.title}
                        englishTranslation={product.englishTranslations?.original.title}
                    />
                    <TextPanel
                        label="Suggested title"
                        languageTag={languageTag}
                        value={suggestion.value}
                        englishTranslation={
                            product.displayedSuggestionEnglishTranslations?.title ??
                            product.englishTranslations?.suggestions.title
                        }
                        originalValue={product.title}
                        suggested
                    />
                </div>
                <Reasoning>{suggestion.reasoning}</Reasoning>
            </CardContent>
        </Card>
    );
}

function FeatureComparison({ product, languageTag }: { product: Product; languageTag: string }) {
    const suggestion = product.suggestions?.productFeatures;
    if (!suggestion) return <PendingSuggestions />;

    return (
        <Card>
            <CardHeader>
                <ComparisonHeader icon={<ListChecks className="size-4" />} title="Product features" />
            </CardHeader>
            <CardContent>
                <div className="grid gap-4 lg:grid-cols-2">
                    <ListPanel
                        label="Current features"
                        languageTag={languageTag}
                        values={product.productFeatures}
                        englishTranslations={product.englishTranslations?.original.productFeatures}
                    />
                    <ListPanel
                        label="Suggested features"
                        languageTag={languageTag}
                        values={suggestion.value}
                        englishTranslations={
                            product.displayedSuggestionEnglishTranslations?.productFeatures ??
                            product.englishTranslations?.suggestions.productFeatures
                        }
                        originalValues={product.productFeatures}
                        suggested
                    />
                </div>
                <Reasoning>{suggestion.reasoning}</Reasoning>
            </CardContent>
        </Card>
    );
}

function DescriptionComparison({ product, languageTag }: { product: Product; languageTag: string }) {
    const suggestion = product.suggestions?.description;
    if (!suggestion) return <PendingSuggestions />;

    return (
        <Card>
            <CardHeader>
                <ComparisonHeader icon={<FileText className="size-4" />} title="Description" />
            </CardHeader>
            <CardContent>
                <div className="grid gap-4 lg:grid-cols-2">
                    <TextPanel
                        label="Current description"
                        languageTag={languageTag}
                        value={product.description}
                        englishTranslation={product.englishTranslations?.original.description}
                    />
                    <TextPanel
                        label="Suggested description"
                        languageTag={languageTag}
                        value={suggestion.value}
                        englishTranslation={
                            product.displayedSuggestionEnglishTranslations?.description ??
                            product.englishTranslations?.suggestions.description
                        }
                        originalValue={product.description}
                        suggested
                    />
                </div>
                <Reasoning>{suggestion.reasoning}</Reasoning>
            </CardContent>
        </Card>
    );
}

function TextPanel({
    label,
    languageTag,
    value,
    englishTranslation,
    originalValue,
    suggested = false
}: {
    label: string;
    languageTag: string;
    value: string;
    englishTranslation?: string;
    originalValue?: string;
    suggested?: boolean;
}) {
    return (
        <div
            className={cn(
                "relative rounded-xl border p-5",
                suggested ? "border-primary/30 bg-primary/[0.035]" : "bg-muted/35"
            )}
        >
            <div className="mb-4 flex flex-wrap items-center gap-2">
                <Badge variant={suggested ? "default" : "secondary"}>
                    {suggested && <Sparkles />}
                    {label}
                </Badge>
                <div className="ml-auto flex items-center gap-1">
                    <CharacterMetrics
                        count={countCharacters(value)}
                        originalCount={
                            originalValue === undefined ? undefined : countCharacters(originalValue)
                        }
                    />
                    <CopyButton value={value} />
                </div>
            </div>
            <p lang={languageTag} className="whitespace-pre-line text-sm leading-7">
                {value || "—"}
            </p>
            {englishTranslation !== undefined && value.trim() !== "" && (
                <EnglishTranslationReveal>
                    <p className="whitespace-pre-line">{englishTranslation || "—"}</p>
                </EnglishTranslationReveal>
            )}
        </div>
    );
}

function ListPanel({
    label,
    languageTag,
    values,
    englishTranslations,
    originalValues,
    suggested = false
}: {
    label: string;
    languageTag: string;
    values: string[];
    englishTranslations?: string[];
    originalValues?: string[];
    suggested?: boolean;
}) {
    const characterCount = values.reduce((total, value) => total + countCharacters(value), 0);
    const originalCharacterCount = originalValues?.reduce(
        (total, value) => total + countCharacters(value),
        0
    );

    return (
        <div
            className={cn(
                "rounded-xl border p-5",
                suggested ? "border-primary/30 bg-primary/[0.035]" : "bg-muted/35"
            )}
        >
            <div className="mb-4 flex flex-wrap items-center gap-2">
                <Badge variant={suggested ? "default" : "secondary"}>
                    {suggested && <Sparkles />}
                    {label}
                </Badge>
                <div className="ml-auto">
                    <CharacterMetrics count={characterCount} originalCount={originalCharacterCount} />
                </div>
            </div>
            <ol className="space-y-3">
                {values.map((value, index) => (
                    <li key={`${index}-${value}`} className="flex items-start gap-3 text-sm leading-6">
                        <span
                            className={cn(
                                "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold",
                                suggested
                                    ? "bg-primary text-primary-foreground"
                                    : "bg-secondary text-secondary-foreground"
                            )}
                        >
                            {index + 1}
                        </span>
                        <span className="min-w-0 flex-1">
                            <span lang={languageTag}>{value}</span>
                            {englishTranslations?.[index] !== undefined && (
                                <EnglishTranslationReveal>
                                    <span>{englishTranslations[index]}</span>
                                </EnglishTranslationReveal>
                            )}
                        </span>
                        <CopyButton value={value} label={`Copy feature ${index + 1}`} />
                    </li>
                ))}
            </ol>
        </div>
    );
}

function SuggestionRegenerator({
    market,
    product,
    refined,
    onRegenerated,
    onRestore
}: {
    market: Market;
    product: Product;
    refined: boolean;
    onRegenerated: (refinement: RefinedSuggestions) => void;
    onRestore: () => void;
}) {
    const [open, setOpen] = useState(false);
    const [feedback, setFeedback] = useState("");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string>();
    const formId = `suggestion-feedback-${market}-${product.asin}`;

    async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
        event.preventDefault();
        const additionalFeedback = feedback.trim();
        if (additionalFeedback === "" || loading) return;

        setLoading(true);
        setError(undefined);

        try {
            if (!product.reviewSentiment) {
                throw new Error(
                    "Review sentiment analysis is unavailable for this product. Rebuild the report before regenerating suggestions."
                );
            }
            const refinement = await regenerateSuggestions(
                reportAiConfig,
                market,
                { ...product, reviewSentiment: product.reviewSentiment },
                product.suggestions,
                additionalFeedback
            );
            onRegenerated(refinement);
            setFeedback("");
            setOpen(false);
        } catch (requestError) {
            setError(requestError instanceof Error ? requestError.message : String(requestError));
        } finally {
            setLoading(false);
        }
    }

    return (
        <Card className="gap-0 overflow-hidden border-primary/25 py-0">
            <CardContent className="p-0">
                <div className="flex flex-col gap-4 bg-primary/[0.035] p-5 sm:flex-row sm:items-center sm:justify-between">
                    <div className="flex min-w-0 gap-3">
                        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                            <MessageSquarePlus className="size-5" />
                        </span>
                        <div>
                            <p className="font-semibold">Want to refine the recommendations?</p>
                            <p className="mt-1 text-sm leading-6 text-muted-foreground">
                                Add product knowledge, keyword priorities, or editorial direction and ask{" "}
                                {reportAiConfig.providerName} to reconsider the complete listing and
                                refresh its English translation.
                            </p>
                        </div>
                    </div>
                    <Button
                        type="button"
                        variant={open ? "secondary" : "default"}
                        className="h-auto min-h-9 shrink sm:shrink-0"
                        onClick={() => {
                            setOpen(value => !value);
                            setError(undefined);
                        }}
                        aria-expanded={open}
                        aria-controls={formId}
                    >
                        <Sparkles />
                        {open ? "Hide feedback form" : "Regenerate suggestions with additional feedback"}
                    </Button>
                </div>

                {refined && !open && (
                    <div
                        className="flex flex-col gap-3 border-t border-primary/15 px-5 py-3 text-sm sm:flex-row sm:items-center sm:justify-between"
                        role="status"
                    >
                        <span className="text-muted-foreground">
                            Browser-refined suggestions are displayed and saved on this device.
                        </span>
                        <Button type="button" variant="ghost" size="sm" onClick={onRestore}>
                            <RotateCcw /> Restore report suggestions
                        </Button>
                    </div>
                )}

                {open && (
                    <form
                        id={formId}
                        className="space-y-4 border-t p-5"
                        onSubmit={event => void submit(event)}
                    >
                        <div>
                            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                                <label htmlFor={`${formId}-text`} className="text-sm font-semibold">
                                    Additional feedback
                                </label>
                                <Badge variant="outline">
                                    {reportAiConfig.providerName} · {reportAiConfig.model}
                                </Badge>
                            </div>
                            <Textarea
                                id={`${formId}-text`}
                                value={feedback}
                                onChange={event => setFeedback(event.target.value)}
                                placeholder={
                                    "Example: “idée cadeau voyage” is an important search phrase and must remain in the title."
                                }
                                maxLength={4_000}
                                required
                                disabled={loading}
                                autoFocus
                            />
                            <div className="mt-2 flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
                                <span>
                                    Feedback guides priorities and wording but is not treated as a new
                                    product fact.
                                </span>
                                <span className="font-mono">{feedback.length}/4,000</span>
                            </div>
                        </div>

                        {error && (
                            <div
                                className="flex gap-3 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-700 dark:text-red-300"
                                role="alert"
                            >
                                <AlertCircle className="mt-0.5 size-4 shrink-0" />
                                <span className="min-w-0 break-words">{error}</span>
                            </div>
                        )}

                        <div className="flex flex-wrap items-center justify-end gap-2">
                            <Button
                                type="button"
                                variant="ghost"
                                onClick={() => {
                                    setOpen(false);
                                    setError(undefined);
                                }}
                                disabled={loading}
                            >
                                Cancel
                            </Button>
                            <Button type="submit" disabled={loading || feedback.trim() === ""}>
                                {loading ? (
                                    <>
                                        <LoaderCircle className="animate-spin" />
                                        Regenerating and translating with {reportAiConfig.providerName}…
                                    </>
                                ) : (
                                    <>
                                        <Sparkles /> Regenerate suggestions
                                    </>
                                )}
                            </Button>
                        </div>
                    </form>
                )}
            </CardContent>
        </Card>
    );
}

function PendingSuggestions() {
    return (
        <Card className="border-dashed">
            <CardContent className="flex items-center gap-3 py-4 text-muted-foreground">
                <Sparkles className="size-5" />
                Suggestions are not available for this product yet.
            </CardContent>
        </Card>
    );
}

type ReviewEntry = {
    index: number;
    review: Review;
    sentiment: ReviewSentiment;
    translation?: ProductEnglishTranslations["reviews"][number];
};

function sortReviewsByEvidence(entries: ReviewEntry[]): ReviewEntry[] {
    return [...entries].sort((left, right) => {
        const helpfulDifference = right.review.helpfulCount - left.review.helpfulCount;
        if (helpfulDifference !== 0) return helpfulDifference;

        if (left.review.date !== right.review.date) {
            if (left.review.date === null) return 1;
            if (right.review.date === null) return -1;
            return right.review.date.localeCompare(left.review.date);
        }

        return left.index - right.index;
    });
}

function ReviewCard({ entry, languageTag }: { entry: ReviewEntry; languageTag: string }) {
    const { review, translation, sentiment, index } = entry;
    const helpfulLabel = `${review.helpfulCount.toLocaleString("en")} ${
        review.helpfulCount === 1 ? "person" : "people"
    } found this helpful`;

    return (
        <Card key={review.id ?? `${index}-${review.comment}`} className="gap-4 py-5">
            <CardHeader className="px-5">
                <div className="space-y-3">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <RatingStars rating={review.rating} />
                        <div className="flex flex-wrap items-center gap-2">
                            <Badge
                                variant="outline"
                                className={cn(
                                    sentiment === "positive"
                                        ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                                        : "border-red-500/30 bg-red-500/10 text-red-700 dark:text-red-300"
                                )}
                            >
                                {sentiment === "positive" ? <ThumbsUp /> : <ThumbsDown />}
                                {sentiment === "positive" ? "Positive" : "Negative"}
                            </Badge>
                            <Badge variant="outline">{review.rating}/5</Badge>
                            {review.verifiedPurchase && (
                                <Badge variant="secondary">Verified purchase</Badge>
                            )}
                            <CopyButton
                                value={[review.title, review.comment]
                                    .filter((value): value is string => Boolean(value))
                                    .join("\n\n")}
                                label="Copy this review"
                            />
                        </div>
                    </div>
                    {review.title && (
                        <CardTitle
                            lang={review.sourceLanguage ?? languageTag}
                            className="text-base leading-6"
                        >
                            {review.title}
                        </CardTitle>
                    )}
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                        <span className="inline-flex items-center gap-1 font-medium text-foreground/70">
                            <ThumbsUp className="size-3.5" /> {helpfulLabel}
                        </span>
                        {(review.dateText || review.variant) && (
                            <span
                                lang={review.sourceLanguage ?? languageTag}
                                className="flex flex-wrap gap-x-3 gap-y-1"
                            >
                                {review.dateText && <span>{review.dateText}</span>}
                                {review.variant && <span>{review.variant}</span>}
                            </span>
                        )}
                    </div>
                </div>
            </CardHeader>
            <CardContent
                lang={review.sourceLanguage ?? languageTag}
                className="px-5 text-sm leading-6 text-muted-foreground"
            >
                “{review.comment}”
            </CardContent>
            {translation && (
                <div className="px-5">
                    <EnglishTranslationReveal>
                        <div className="space-y-2">
                            {translation.title && (
                                <p className="font-semibold text-foreground/75 not-italic">
                                    {translation.title}
                                </p>
                            )}
                            {(translation.dateText || translation.variant) && (
                                <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs">
                                    {translation.dateText && <span>{translation.dateText}</span>}
                                    {translation.variant && <span>{translation.variant}</span>}
                                </div>
                            )}
                            <p>“{translation.comment}”</p>
                        </div>
                    </EnglishTranslationReveal>
                </div>
            )}
        </Card>
    );
}

function SentimentReviewPanel({
    sentiment,
    summary,
    entries,
    languageTag
}: {
    sentiment: ReviewSentiment;
    summary: string;
    entries: ReviewEntry[];
    languageTag: string;
}) {
    const positive = sentiment === "positive";

    return (
        <div className="space-y-4">
            <Card
                className={cn(
                    positive
                        ? "border-emerald-500/25 bg-emerald-500/[0.035]"
                        : "border-red-500/25 bg-red-500/[0.035]"
                )}
            >
                <CardHeader>
                    <div className="flex items-center gap-2">
                        <span
                            className={cn(
                                "flex size-8 items-center justify-center rounded-lg",
                                positive
                                    ? "bg-emerald-500/10 text-emerald-600"
                                    : "bg-red-500/10 text-red-600"
                            )}
                        >
                            {positive ? (
                                <ThumbsUp className="size-4" />
                            ) : (
                                <ThumbsDown className="size-4" />
                            )}
                        </span>
                        <CardTitle>
                            {positive ? "Positive review summary" : "Negative review summary"}
                        </CardTitle>
                    </div>
                </CardHeader>
                <CardContent>
                    <p lang="en" className="text-sm leading-7 text-muted-foreground">
                        {summary}
                    </p>
                </CardContent>
            </Card>

            {entries.length > 0 ? (
                <div className="max-h-[760px] space-y-4 overflow-y-auto pr-1">
                    {entries.map(entry => (
                        <ReviewCard
                            key={entry.review.id ?? `${entry.index}-${entry.review.comment}`}
                            entry={entry}
                            languageTag={languageTag}
                        />
                    ))}
                </div>
            ) : (
                <Card className="border-dashed">
                    <CardContent className="py-8 text-center text-sm text-muted-foreground">
                        No {sentiment} reviews were present in the eligible extracted corpus.
                    </CardContent>
                </Card>
            )}
        </div>
    );
}

function ReviewsView({
    reviews,
    sentimentAnalysis,
    translations,
    languageTag
}: {
    reviews: ProductReviews;
    sentimentAnalysis?: ReviewSentimentAnalysis;
    translations?: ProductEnglishTranslations["reviews"];
    languageTag: string;
}) {
    const criticalCoverage = reviews.items.filter(
        review => review.selectionReason === "critical"
    ).length;
    const collectedAt = reviews.collection.collectedAt
        ? new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(
              new Date(reviews.collection.collectedAt)
          )
        : undefined;
    const sentimentByReviewKey = new Map(
        sentimentAnalysis?.classifications.map(classification => [
            classification.reviewKey,
            classification.sentiment
        ]) ?? []
    );
    const entries = reviews.items.flatMap((review, index): ReviewEntry[] => {
        const sentiment = sentimentByReviewKey.get(createReviewKey(review, index));
        return sentiment ? [{ index, review, sentiment, translation: translations?.[index] }] : [];
    });
    const positiveEntries = sortReviewsByEvidence(
        entries.filter(entry => entry.sentiment === "positive")
    );
    const negativeEntries = sortReviewsByEvidence(
        entries.filter(entry => entry.sentiment === "negative")
    );
    const defaultSentiment = positiveEntries.length > 0 ? "positive" : "negative";

    return (
        <div className="space-y-6">
            <Card>
                <CardHeader>
                    <CardTitle>Review overview</CardTitle>
                    <CardDescription>
                        Aggregate data shown by Amazon. The qualitative AI corpus contains{" "}
                        {reviews.items.length} reviews no older than one year
                        {criticalCoverage > 0
                            ? `, including ${criticalCoverage} added for 1–3-star concern coverage`
                            : ""}
                        .
                    </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4">
                    <div className="grid gap-4 sm:grid-cols-2">
                        <div className="flex min-h-40 flex-col items-center justify-center rounded-xl bg-muted/40 p-6 text-center">
                            <span className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
                                Amazon overall rating
                            </span>
                            <span className="mt-3 text-5xl font-bold tracking-tight">
                                {reviews.overallRating.toFixed(1)}
                                <span className="text-xl text-muted-foreground">/5</span>
                            </span>
                            <RatingStars rating={reviews.overallRating} />
                        </div>
                        <div className="flex min-h-40 flex-col items-center justify-center rounded-xl bg-muted/40 p-6 text-center">
                            <span className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
                                Total review count
                            </span>
                            <span className="mt-3 text-5xl font-bold tracking-tight">
                                {reviews.totalCount.toLocaleString("en")}
                            </span>
                            <span className="mt-1 inline-flex items-center gap-2 text-sm text-muted-foreground">
                                <UsersRound className="size-4" /> Amazon customer reviews
                            </span>
                        </div>
                    </div>

                    <div className="rounded-xl border border-primary/20 bg-primary/5 p-5">
                        <p className="mb-2 text-xs font-semibold tracking-widest text-primary uppercase">
                            Overall sentiment
                        </p>
                        <p lang="en" className="text-sm leading-7 text-muted-foreground">
                            {sentimentAnalysis?.overallSummary ??
                                "Sentiment analysis is not available for this product yet."}
                        </p>
                    </div>
                </CardContent>
            </Card>

            {sentimentAnalysis && (
                <Tabs defaultValue={defaultSentiment}>
                    <TabsList className="grid w-full grid-cols-2 sm:w-[470px]">
                        <TabsTrigger value="positive" aria-label="Positive sentiment reviews">
                            <ThumbsUp />
                            <span>
                                Positive sentiment<span className="hidden sm:inline"> reviews</span> (
                                {positiveEntries.length})
                            </span>
                        </TabsTrigger>
                        <TabsTrigger value="negative" aria-label="Negative sentiment reviews">
                            <ThumbsDown />
                            <span>
                                Negative sentiment<span className="hidden sm:inline"> reviews</span> (
                                {negativeEntries.length})
                            </span>
                        </TabsTrigger>
                    </TabsList>
                    <TabsContent value="positive" className="mt-4">
                        <SentimentReviewPanel
                            sentiment="positive"
                            summary={sentimentAnalysis.positiveSummary}
                            entries={positiveEntries}
                            languageTag={languageTag}
                        />
                    </TabsContent>
                    <TabsContent value="negative" className="mt-4">
                        <SentimentReviewPanel
                            sentiment="negative"
                            summary={sentimentAnalysis.negativeSummary}
                            entries={negativeEntries}
                            languageTag={languageTag}
                        />
                    </TabsContent>
                </Tabs>
            )}

            <p className="text-center text-xs text-muted-foreground">
                Review corpus collected with the recent-balanced strategy
                {collectedAt ? ` on ${collectedAt}` : ""}
                {reviews.collection.reviewCutoffDate
                    ? `; reviews before ${reviews.collection.reviewCutoffDate} were excluded`
                    : ""}
                . Aggregate totals remain Amazon's full-listing figures.
            </p>
        </div>
    );
}

function ProductHero({ market, product }: { market: Market; product: Product }) {
    const metadata = marketMetadata[market];

    return (
        <Card className="overflow-hidden border-0 bg-hero text-white shadow-xl shadow-primary/10">
            <CardContent className="grid gap-6 p-6 sm:grid-cols-[180px_1fr] lg:p-8">
                <div className="flex min-h-44 min-w-0 items-center justify-center overflow-hidden rounded-xl bg-white p-5 shadow-sm">
                    <img
                        src={product.productImageUrl}
                        alt={product.title}
                        lang={metadata.languageTag}
                        className="h-52 w-full min-w-0 object-contain"
                    />
                </div>
                <div className="flex min-w-0 flex-col justify-center">
                    <div className="mb-4 flex flex-wrap items-center gap-2">
                        <Badge className="bg-white/15 text-white backdrop-blur-sm">
                            {metadata.flag} {metadata.label}
                        </Badge>
                        <Badge className="bg-white/10 font-mono text-white">ASIN {product.asin}</Badge>
                        <span className="inline-flex items-center gap-2 text-sm text-white/75">
                            <RatingStars rating={product.reviews.overallRating} size="small" />
                            {product.reviews.overallRating.toFixed(1)} ·{" "}
                            {product.reviews.totalCount.toLocaleString("en")} reviews
                        </span>
                    </div>
                    <h1
                        lang={metadata.languageTag}
                        className="max-w-4xl text-balance text-2xl leading-tight font-bold sm:text-3xl"
                    >
                        {product.title}
                    </h1>
                    {product.englishTranslations?.original.title && (
                        <EnglishTranslationReveal
                            buttonClassName="text-white/75 hover:bg-white/10 hover:text-white"
                            className="border-white/30 text-white/75"
                        >
                            <p className="max-w-4xl text-base">
                                {product.englishTranslations.original.title}
                            </p>
                        </EnglishTranslationReveal>
                    )}
                    <div className="mt-6">
                        <Button asChild variant="secondary" size="sm">
                            <a
                                href={`https://www.${metadata.domain}/dp/${product.asin}`}
                                target="_blank"
                                rel="noreferrer"
                            >
                                View on Amazon <ExternalLink />
                            </a>
                        </Button>
                    </div>
                </div>
            </CardContent>
        </Card>
    );
}

function ProductNavigation({
    market,
    asin,
    query,
    onQueryChange
}: {
    market: Market;
    asin: string;
    query: string;
    onQueryChange: (query: string) => void;
}) {
    const group = reportData.find(item => item.market === market);
    const normalizedQuery = query.trim().toLocaleLowerCase();
    const products =
        group?.products.filter(
            product =>
                product.asin.toLocaleLowerCase().includes(normalizedQuery) ||
                product.title.toLocaleLowerCase().includes(normalizedQuery) ||
                product.englishTranslations?.original.title.toLocaleLowerCase().includes(normalizedQuery)
        ) ?? [];

    return (
        <aside className="hidden h-[calc(100vh-89px)] w-80 shrink-0 flex-col border-r border-border bg-sidebar lg:sticky lg:top-[89px] lg:flex">
            <div className="border-b border-border p-4">
                <p className="mb-3 text-xs font-semibold tracking-widest text-muted-foreground uppercase">
                    Products
                </p>
                <div className="relative">
                    <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        value={query}
                        onChange={event => onQueryChange(event.target.value)}
                        placeholder="Title or ASIN…"
                        className="bg-background pl-9"
                    />
                </div>
            </div>
            <nav className="flex-1 space-y-1 overflow-y-auto p-3" aria-label="Products">
                {products.map(product => (
                    <button
                        key={product.asin}
                        type="button"
                        onClick={() => navigate(market, product.asin)}
                        className={cn(
                            "group flex w-full items-center gap-3 rounded-xl p-2.5 text-left transition-colors",
                            product.asin === asin
                                ? "bg-primary text-primary-foreground shadow-sm"
                                : "hover:bg-accent"
                        )}
                    >
                        <span className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-white p-1.5">
                            <img
                                src={product.productImageUrl}
                                alt=""
                                className="max-h-full max-w-full object-contain"
                            />
                        </span>
                        <span className="min-w-0 flex-1">
                            <span
                                lang={
                                    product.englishTranslations
                                        ? "en"
                                        : marketMetadata[market].languageTag
                                }
                                className="line-clamp-2 text-xs leading-4 font-medium"
                            >
                                {product.englishTranslations?.original.title ?? product.title}
                            </span>
                            <span
                                className={cn(
                                    "mt-1 block font-mono text-[10px]",
                                    product.asin === asin ? "text-white/65" : "text-muted-foreground"
                                )}
                            >
                                {product.asin}
                            </span>
                        </span>
                        <ChevronRight className="size-4 shrink-0 opacity-50" />
                    </button>
                ))}
                {products.length === 0 && (
                    <p className="px-3 py-8 text-center text-sm text-muted-foreground">
                        No products found.
                    </p>
                )}
            </nav>
        </aside>
    );
}

function MobileProductSelector({ market, asin }: { market: Market; asin: string }) {
    const products = reportData.find(item => item.market === market)?.products ?? [];

    return (
        <div className="mb-4 lg:hidden">
            <label
                htmlFor="mobile-product"
                className="mb-2 block text-xs font-semibold text-muted-foreground"
            >
                Product
            </label>
            <select
                id="mobile-product"
                value={asin}
                onChange={event => navigate(market, event.target.value)}
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs"
            >
                {products.map(product => (
                    <option
                        key={product.asin}
                        value={product.asin}
                        lang={product.englishTranslations ? "en" : marketMetadata[market].languageTag}
                    >
                        {product.asin} — {product.englishTranslations?.original.title ?? product.title}
                    </option>
                ))}
            </select>
        </div>
    );
}

function Header({
    market,
    onMarketChange
}: {
    market: Market;
    onMarketChange: (market: Market) => void;
}) {
    const [dark, setDark] = useState(document.documentElement.classList.contains("dark"));
    const totalProducts = reportData.reduce((total, item) => total + item.products.length, 0);
    const totalReviews = reportData.reduce(
        (total, item) =>
            total + item.products.reduce((count, product) => count + product.reviews.items.length, 0),
        0
    );

    function toggleTheme(): void {
        const next = !dark;
        setDark(next);
        document.documentElement.classList.toggle("dark", next);
        localStorage.setItem("review-genius-theme", next ? "dark" : "light");
    }

    return (
        <header className="sticky top-0 z-30 border-b border-border/80 bg-background/90 backdrop-blur-xl">
            <div className="flex min-h-[88px] flex-wrap items-center gap-3 px-4 py-3 sm:flex-nowrap sm:gap-4 sm:px-6 sm:py-0">
                <div className="flex min-w-0 items-center gap-4">
                    <img src={__REPORT_LOGO_URL__} alt="Numberly" className="h-7 w-auto sm:h-9" />
                    <Separator orientation="vertical" className="hidden h-8 sm:block" />
                    <div>
                        <p className="text-sm font-bold tracking-tight sm:text-lg">Review Genius 2.0</p>
                        <p className="text-xs text-muted-foreground">
                            <span className="font-medium text-foreground/80">{reportTitle}</span>
                            <span className="hidden sm:inline">
                                {" "}
                                · {totalProducts} products · {totalReviews} extracted reviews analyzed
                            </span>
                        </p>
                    </div>
                </div>

                <div className="flex w-full items-center justify-between gap-2 sm:ml-auto sm:w-auto sm:justify-start sm:gap-3">
                    <div className="flex rounded-lg bg-muted p-1" role="group" aria-label="Market">
                        {reportData.map(group => {
                            const metadata = marketMetadata[group.market];
                            return (
                                <button
                                    key={group.market}
                                    type="button"
                                    onClick={() => onMarketChange(group.market)}
                                    className={cn(
                                        "flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-all sm:px-3",
                                        market === group.market
                                            ? "bg-background text-foreground shadow-sm"
                                            : "text-muted-foreground hover:text-foreground"
                                    )}
                                    aria-pressed={market === group.market}
                                >
                                    <span>{metadata.flag}</span>
                                    <span className="hidden sm:inline">{metadata.label}</span>
                                    <span className="hidden text-[10px] opacity-60 sm:inline">
                                        {group.products.length}
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                    <Button variant="ghost" size="icon" onClick={toggleTheme} title="Change theme">
                        {dark ? <Sun /> : <Moon />}
                        <span className="sr-only">Change theme</span>
                    </Button>
                </div>
            </div>
        </header>
    );
}

function App() {
    const [selection, setSelection] = useState(getInitialSelection);
    const [query, setQuery] = useState("");
    const [suggestionOverrides, setSuggestionOverrides] =
        useState<SuggestionOverrides>(readSuggestionOverrides);

    useEffect(() => {
        const updateSelection = () => setSelection(getInitialSelection());
        window.addEventListener("hashchange", updateSelection);

        if (!window.location.hash && selection.asin) {
            window.history.replaceState(null, "", `#/${selection.market}/${selection.asin}`);
        }

        return () => window.removeEventListener("hashchange", updateSelection);
    }, [selection.asin, selection.market]);

    const group = useMemo(
        () => reportData.find(item => item.market === selection.market) ?? reportData[0],
        [selection.market]
    );
    const product = group?.products.find(item => item.asin === selection.asin) ?? group?.products[0];
    const selectedProductKey = product ? getProductKey(group?.market ?? "fr", product.asin) : "";
    const refinement = suggestionOverrides[selectedProductKey];
    const displayedProduct = product
        ? {
              ...product,
              suggestions: refinement?.suggestions ?? product.suggestions,
              displayedSuggestionEnglishTranslations:
                  refinement?.englishTranslations ?? product.englishTranslations?.suggestions
          }
        : undefined;

    function updateSuggestionOverride(nextRefinement: RefinedSuggestions): void {
        if (!selectedProductKey) return;

        setSuggestionOverrides(current => {
            const next = { ...current, [selectedProductKey]: nextRefinement };
            writeSuggestionOverrides(next);
            return next;
        });
    }

    function restoreReportSuggestions(): void {
        if (!selectedProductKey) return;

        setSuggestionOverrides(current => {
            const next = { ...current };
            delete next[selectedProductKey];
            writeSuggestionOverrides(next);
            return next;
        });
    }

    function changeMarket(market: Market): void {
        const firstProduct = reportData.find(item => item.market === market)?.products[0];
        setQuery("");
        if (firstProduct) navigate(market, firstProduct.asin);
    }

    if (!group || !product || !displayedProduct) {
        return (
            <main className="flex min-h-screen items-center justify-center p-8 text-center">
                <div>
                    <BarChart3 className="mx-auto mb-4 size-10 text-muted-foreground" />
                    <h1 className="text-xl font-semibold">No products available</h1>
                    <p className="mt-2 text-muted-foreground">Generate the report data first.</p>
                </div>
            </main>
        );
    }

    return (
        <div className="min-h-screen bg-background text-foreground">
            <Header market={group.market} onMarketChange={changeMarket} />
            <div className="flex items-start">
                <ProductNavigation
                    market={group.market}
                    asin={product.asin}
                    query={query}
                    onQueryChange={setQuery}
                />
                <main className="min-w-0 flex-1">
                    <div className="mx-auto max-w-[1500px] p-4 sm:p-6 lg:p-8">
                        <MobileProductSelector market={group.market} asin={product.asin} />
                        <ProductHero market={group.market} product={product} />

                        <Tabs defaultValue="suggestions" className="mt-6">
                            <TabsList className="grid w-full grid-cols-2 sm:w-[430px]">
                                <TabsTrigger value="suggestions">
                                    <Sparkles /> Suggestions
                                </TabsTrigger>
                                <TabsTrigger value="reviews">
                                    <UsersRound /> Extracted reviews ({product.reviews.items.length})
                                </TabsTrigger>
                            </TabsList>
                            <TabsContent value="suggestions" className="mt-4 space-y-5">
                                <div className="flex flex-wrap items-end justify-between gap-3 py-2">
                                    <div>
                                        <p className="text-sm font-semibold text-primary">
                                            AI recommendations
                                        </p>
                                        <h2 className="mt-1 text-2xl font-bold tracking-tight">
                                            Proposed optimizations
                                        </h2>
                                    </div>
                                    <p className="max-w-xl text-sm leading-6 text-muted-foreground">
                                        Suggestions use the product listing and extracted customer
                                        feedback to create clearer, more persuasive product copy.
                                    </p>
                                </div>
                                <SuggestionRegenerator
                                    key={selectedProductKey}
                                    market={group.market}
                                    product={displayedProduct}
                                    refined={refinement !== undefined}
                                    onRegenerated={updateSuggestionOverride}
                                    onRestore={restoreReportSuggestions}
                                />
                                <TitleComparison
                                    product={displayedProduct}
                                    languageTag={marketMetadata[group.market].languageTag}
                                />
                                <FeatureComparison
                                    product={displayedProduct}
                                    languageTag={marketMetadata[group.market].languageTag}
                                />
                                <DescriptionComparison
                                    product={displayedProduct}
                                    languageTag={marketMetadata[group.market].languageTag}
                                />
                            </TabsContent>
                            <TabsContent value="reviews" className="mt-6">
                                <ReviewsView
                                    reviews={product.reviews}
                                    sentimentAnalysis={product.reviewSentiment}
                                    translations={product.englishTranslations?.reviews}
                                    languageTag={marketMetadata[group.market].languageTag}
                                />
                            </TabsContent>
                        </Tabs>

                        <footer className="mt-10 flex flex-wrap items-center justify-between gap-3 border-t py-6 text-xs text-muted-foreground">
                            <span>Review Genius 2.0 · {reportTitle} report</span>
                            <span className="inline-flex items-center gap-1">
                                Self-contained local report <ArrowRight className="size-3" />{" "}
                                {marketMetadata[group.market].label}
                            </span>
                        </footer>
                    </div>
                </main>
            </div>
        </div>
    );
}

createRoot(document.getElementById("root")!).render(<App />);
