import {
    ArrowRight,
    BarChart3,
    Check,
    ChevronRight,
    Clipboard,
    ExternalLink,
    FileText,
    Lightbulb,
    ListChecks,
    Moon,
    Search,
    Sparkles,
    Star,
    Sun,
    Tag,
    UsersRound
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Badge } from "./components/ui/badge.js";
import { Button } from "./components/ui/button.js";
import {
    Card,
    CardAction,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle
} from "./components/ui/card.js";
import { Input } from "./components/ui/input.js";
import { Separator } from "./components/ui/separator.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./components/ui/tabs.js";
import { cn } from "./lib/utils.js";

type Market = "fr" | "it" | "es" | "de" | "be" | "nl";
type Review = {
    rating: 1 | 2 | 3 | 4 | 5;
    title: string | null;
    comment: string;
};
type ProductReviews = {
    overallRating: number;
    totalCount: number;
    items: Review[];
};
type Suggestion<Value> = { value: Value; reasoning: string };
type Product = {
    asin: string;
    title: string;
    productFeatures: string[];
    description: string;
    productImageUrl: string;
    reviews: ProductReviews;
    suggestions?: {
        title: Suggestion<string>;
        productFeatures: Suggestion<string[]>;
        description: Suggestion<string>;
    };
};
type ReportData = { market: Market; products: Product[] }[];

declare const __REPORT_DATA__: ReportData;

const reportData = __REPORT_DATA__;
const marketMetadata: Record<Market, { label: string; flag: string; domain: string }> = {
    fr: { label: "France", flag: "🇫🇷", domain: "amazon.fr" },
    it: { label: "Italie", flag: "🇮🇹", domain: "amazon.it" },
    es: { label: "Espagne", flag: "🇪🇸", domain: "amazon.es" },
    de: { label: "Allemagne", flag: "🇩🇪", domain: "amazon.de" },
    be: { label: "Belgique", flag: "🇧🇪", domain: "amazon.com.be" },
    nl: { label: "Pays-Bas", flag: "🇳🇱", domain: "amazon.nl" }
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
        <span className="inline-flex items-center gap-0.5" aria-label={`${rating} étoiles sur 5`}>
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

function CopyButton({ value }: { value: string }) {
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
        <Button variant="ghost" size="icon" onClick={() => void copy()} title="Copier">
            {copied ? <Check className="text-emerald-600" /> : <Clipboard />}
            <span className="sr-only">Copier</span>
        </Button>
    );
}

function Reasoning({ children }: { children: string }) {
    return (
        <div className="mt-5 flex gap-3 rounded-lg border border-primary/20 bg-primary/5 p-4 text-sm leading-6">
            <Lightbulb className="mt-0.5 size-4 shrink-0 text-primary" />
            <div>
                <p className="mb-1 font-semibold text-primary">Pourquoi cette version ?</p>
                <p className="text-muted-foreground">{children}</p>
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

function TitleComparison({ product }: { product: Product }) {
    const suggestion = product.suggestions?.title;
    if (!suggestion) return <PendingSuggestions />;

    return (
        <Card>
            <CardHeader>
                <ComparisonHeader icon={<Tag className="size-4" />} title="Titre produit" />
            </CardHeader>
            <CardContent>
                <div className="grid gap-4 lg:grid-cols-2">
                    <TextPanel label="Titre actuel" value={product.title} />
                    <TextPanel label="Titre suggéré" value={suggestion.value} suggested />
                </div>
                <Reasoning>{suggestion.reasoning}</Reasoning>
            </CardContent>
        </Card>
    );
}

function FeatureComparison({ product }: { product: Product }) {
    const suggestion = product.suggestions?.productFeatures;
    if (!suggestion) return <PendingSuggestions />;

    return (
        <Card>
            <CardHeader>
                <ComparisonHeader
                    icon={<ListChecks className="size-4" />}
                    title="Caractéristiques produit"
                />
            </CardHeader>
            <CardContent>
                <div className="grid gap-4 lg:grid-cols-2">
                    <ListPanel label="Caractéristiques actuelles" values={product.productFeatures} />
                    <ListPanel label="Caractéristiques suggérées" values={suggestion.value} suggested />
                </div>
                <Reasoning>{suggestion.reasoning}</Reasoning>
            </CardContent>
        </Card>
    );
}

function DescriptionComparison({ product }: { product: Product }) {
    const suggestion = product.suggestions?.description;
    if (!suggestion) return <PendingSuggestions />;

    return (
        <Card>
            <CardHeader>
                <ComparisonHeader icon={<FileText className="size-4" />} title="Description" />
            </CardHeader>
            <CardContent>
                <div className="grid gap-4 lg:grid-cols-2">
                    <TextPanel label="Description actuelle" value={product.description} />
                    <TextPanel label="Description suggérée" value={suggestion.value} suggested />
                </div>
                <Reasoning>{suggestion.reasoning}</Reasoning>
            </CardContent>
        </Card>
    );
}

function TextPanel({
    label,
    value,
    suggested = false
}: {
    label: string;
    value: string;
    suggested?: boolean;
}) {
    return (
        <div
            className={cn(
                "relative rounded-xl border p-5",
                suggested ? "border-primary/30 bg-primary/[0.035]" : "bg-muted/35"
            )}
        >
            <div className="mb-4 flex items-center justify-between gap-2">
                <Badge variant={suggested ? "default" : "secondary"}>
                    {suggested && <Sparkles />}
                    {label}
                </Badge>
                <CopyButton value={value} />
            </div>
            <p className="whitespace-pre-line text-sm leading-7">{value || "—"}</p>
        </div>
    );
}

function ListPanel({
    label,
    values,
    suggested = false
}: {
    label: string;
    values: string[];
    suggested?: boolean;
}) {
    return (
        <div
            className={cn(
                "rounded-xl border p-5",
                suggested ? "border-primary/30 bg-primary/[0.035]" : "bg-muted/35"
            )}
        >
            <div className="mb-4 flex items-center justify-between gap-2">
                <Badge variant={suggested ? "default" : "secondary"}>
                    {suggested && <Sparkles />}
                    {label}
                </Badge>
                <CopyButton value={values.join("\n")} />
            </div>
            <ol className="space-y-3">
                {values.map((value, index) => (
                    <li key={`${index}-${value}`} className="flex gap-3 text-sm leading-6">
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
                        <span>{value}</span>
                    </li>
                ))}
            </ol>
        </div>
    );
}

function PendingSuggestions() {
    return (
        <Card className="border-dashed">
            <CardContent className="flex items-center gap-3 py-4 text-muted-foreground">
                <Sparkles className="size-5" />
                Les suggestions ne sont pas encore disponibles pour ce produit.
            </CardContent>
        </Card>
    );
}

function ReviewsView({ reviews }: { reviews: ProductReviews }) {
    return (
        <div className="space-y-6">
            <Card>
                <CardHeader>
                    <CardTitle>Vue d’ensemble des avis</CardTitle>
                    <CardDescription>
                        Données agrégées affichées par Amazon. {reviews.items.length} avis ont été
                        extraits pour alimenter les recommandations.
                    </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-4 sm:grid-cols-2">
                    <div className="flex min-h-40 flex-col items-center justify-center rounded-xl bg-muted/40 p-6 text-center">
                        <span className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
                            Note globale Amazon
                        </span>
                        <span className="mt-3 text-5xl font-bold tracking-tight">
                            {reviews.overallRating.toFixed(1)}
                            <span className="text-xl text-muted-foreground">/5</span>
                        </span>
                        <RatingStars rating={reviews.overallRating} />
                    </div>
                    <div className="flex min-h-40 flex-col items-center justify-center rounded-xl bg-muted/40 p-6 text-center">
                        <span className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
                            Nombre total d’avis
                        </span>
                        <span className="mt-3 text-5xl font-bold tracking-tight">
                            {reviews.totalCount.toLocaleString()}
                        </span>
                        <span className="mt-1 inline-flex items-center gap-2 text-sm text-muted-foreground">
                            <UsersRound className="size-4" /> avis clients Amazon
                        </span>
                    </div>
                </CardContent>
            </Card>

            <div className="grid gap-4 lg:grid-cols-2">
                {reviews.items.map((review, index) => (
                    <Card key={`${index}-${review.comment}`} className="gap-4 py-5">
                        <CardHeader className="px-5">
                            <div className="space-y-3">
                                <div className="flex items-center justify-between gap-3">
                                    <RatingStars rating={review.rating} />
                                    <Badge variant="outline">{review.rating}/5</Badge>
                                </div>
                                {review.title && (
                                    <CardTitle className="text-base leading-6">{review.title}</CardTitle>
                                )}
                            </div>
                        </CardHeader>
                        <CardContent className="px-5 text-sm leading-6 text-muted-foreground">
                            “{review.comment}”
                        </CardContent>
                    </Card>
                ))}
            </div>
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
                            {product.reviews.totalCount.toLocaleString()} avis
                        </span>
                    </div>
                    <h1 className="max-w-4xl text-balance text-2xl leading-tight font-bold sm:text-3xl">
                        {product.title}
                    </h1>
                    <div className="mt-6">
                        <Button asChild variant="secondary" size="sm">
                            <a
                                href={`https://www.${metadata.domain}/dp/${product.asin}`}
                                target="_blank"
                                rel="noreferrer"
                            >
                                Voir sur Amazon <ExternalLink />
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
                product.title.toLocaleLowerCase().includes(normalizedQuery)
        ) ?? [];

    return (
        <aside className="hidden h-[calc(100vh-89px)] w-80 shrink-0 flex-col border-r border-border bg-sidebar lg:sticky lg:top-[89px] lg:flex">
            <div className="border-b border-border p-4">
                <p className="mb-3 text-xs font-semibold tracking-widest text-muted-foreground uppercase">
                    Produits
                </p>
                <div className="relative">
                    <Search className="absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                        value={query}
                        onChange={event => onQueryChange(event.target.value)}
                        placeholder="Titre ou ASIN…"
                        className="bg-background pl-9"
                    />
                </div>
            </div>
            <nav className="flex-1 space-y-1 overflow-y-auto p-3" aria-label="Produits">
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
                            <span className="line-clamp-2 text-xs leading-4 font-medium">
                                {product.title}
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
                        Aucun produit trouvé.
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
                Produit
            </label>
            <select
                id="mobile-product"
                value={asin}
                onChange={event => navigate(market, event.target.value)}
                className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm shadow-xs"
            >
                {products.map(product => (
                    <option key={product.asin} value={product.asin}>
                        {product.asin} — {product.title}
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
                    <img src="./assets/numberly-logo.svg" alt="Numberly" className="h-7 w-auto sm:h-9" />
                    <Separator orientation="vertical" className="hidden h-8 sm:block" />
                    <div>
                        <p className="text-sm font-bold tracking-tight sm:text-lg">Review Genius 2.0</p>
                        <p className="hidden text-xs text-muted-foreground sm:block">
                            {totalProducts} produits · {totalReviews} avis analysés
                        </p>
                    </div>
                </div>

                <div className="flex w-full items-center justify-between gap-2 sm:ml-auto sm:w-auto sm:justify-start sm:gap-3">
                    <div className="flex rounded-lg bg-muted p-1" role="group" aria-label="Marché">
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
                    <Button variant="ghost" size="icon" onClick={toggleTheme} title="Changer de thème">
                        {dark ? <Sun /> : <Moon />}
                        <span className="sr-only">Changer de thème</span>
                    </Button>
                </div>
            </div>
        </header>
    );
}

function App() {
    const [selection, setSelection] = useState(getInitialSelection);
    const [query, setQuery] = useState("");

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

    function changeMarket(market: Market): void {
        const firstProduct = reportData.find(item => item.market === market)?.products[0];
        setQuery("");
        if (firstProduct) navigate(market, firstProduct.asin);
    }

    if (!group || !product) {
        return (
            <main className="flex min-h-screen items-center justify-center p-8 text-center">
                <div>
                    <BarChart3 className="mx-auto mb-4 size-10 text-muted-foreground" />
                    <h1 className="text-xl font-semibold">Aucun produit disponible</h1>
                    <p className="mt-2 text-muted-foreground">Générez d’abord les données du rapport.</p>
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
                            <TabsList className="grid w-full grid-cols-2 sm:w-[390px]">
                                <TabsTrigger value="suggestions">
                                    <Sparkles /> Suggestions
                                </TabsTrigger>
                                <TabsTrigger value="reviews">
                                    <UsersRound /> Avis extraits ({product.reviews.items.length})
                                </TabsTrigger>
                            </TabsList>
                            <TabsContent value="suggestions" className="mt-4 space-y-5">
                                <div className="flex flex-wrap items-end justify-between gap-3 py-2">
                                    <div>
                                        <p className="text-sm font-semibold text-primary">
                                            Recommandations IA
                                        </p>
                                        <h2 className="mt-1 text-2xl font-bold tracking-tight">
                                            Optimisations proposées
                                        </h2>
                                    </div>
                                    <p className="max-w-xl text-sm leading-6 text-muted-foreground">
                                        Les suggestions s’appuient sur la fiche produit et les retours
                                        clients, tout en conservant la langue du marché.
                                    </p>
                                </div>
                                <TitleComparison product={product} />
                                <FeatureComparison product={product} />
                                <DescriptionComparison product={product} />
                            </TabsContent>
                            <TabsContent value="reviews" className="mt-6">
                                <ReviewsView reviews={product.reviews} />
                            </TabsContent>
                        </Tabs>

                        <footer className="mt-10 flex flex-wrap items-center justify-between gap-3 border-t py-6 text-xs text-muted-foreground">
                            <span>Review Genius 2.0 · Rapport Smartbox 2026</span>
                            <span className="inline-flex items-center gap-1">
                                Analyse locale et autonome <ArrowRight className="size-3" />{" "}
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
