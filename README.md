<p align="center">
  <img src="assets/numberly-logo.svg" alt="Numberly" width="220" />
</p>

<h1 align="center">Review Genius 2.0</h1>

<p align="center">
  Turn Amazon listings and customer reviews into conversion-focused copy recommendations and a self-contained, navigable report.
</p>

<p align="center">
  <strong>TypeScript</strong> · <strong>React</strong> · <strong>DeepSeek</strong> · <strong>Amazon marketplace data</strong>
</p>

## What it does

Review Genius processes a list of Amazon ASINs grouped by market and produces an interactive report for reviewing the original listing alongside AI-generated improvements.

For each product, the tool:

1. Fetches the localized Amazon product page.
2. Extracts the title, feature bullets, description, product image, overall rating, total review count, and a sample of review titles and comments.
3. Sends the complete product and review context to DeepSeek.
4. Generates a market-language title, feature set, and description, plus an English editorial rationale for each suggestion.
5. Builds a self-contained React report with market/product navigation, comparisons, character counts, copy controls, review context, and light/dark themes.

```mermaid
flowchart LR
    A[Market + ASIN input] --> B[Serialized Amazon fetch]
    B --> C[Deterministic parser]
    C --> D[Serialized DeepSeek enrichment]
    D --> E[Validated JSON output]
    E --> F[Self-contained HTML report]
```

External requests are deliberately serialized to reduce load on Amazon and avoid parallel request bursts. Amazon pages and report assets are cached under `.cache/`, allowing interrupted runs to resume without repeating completed work.

## Report preview

### Light theme

![Review Genius report in light theme](assets/report-suggestions-light.png)

### Dark theme

![Review Genius report in dark theme](assets/report-suggestions-dark.png)

## Prerequisites

-   [Git](https://git-scm.com/)
-   [Node.js 22 or newer](https://nodejs.org/) and npm
-   A valid [DeepSeek API key](https://platform.deepseek.com/api_keys)
-   Network access to the Amazon marketplaces being processed

Amazon may block requests originating from datacenter, VPN, or cloud-development IP addresses. Running from a normal domestic connection is recommended if Amazon returns a challenge page. Always use the tool responsibly and respect Amazon's applicable terms and policies.

## Installation

```bash
git clone https://github.com/christycap/review-genius.git
cd review-genius
npm ci
```

Create the local environment file from the committed example:

```bash
cp .env.example .env
```

Then replace the placeholder with your DeepSeek token:

```dotenv
DEEPSEEK_API_KEY=your_deepseek_api_key_here
```

The `.env` file is ignored by Git. Never commit or share a real API key.

## Input format

The build reads [`input/Smartbox_2026.json`](input/Smartbox_2026.json). It must contain one object per market and at least one ASIN per object:

```ts
type Market = "fr" | "it" | "es" | "de" | "be" | "nl";

type Input = Array<{
    market: Market;
    asins: string[];
}>;
```

Example:

```json
[
    {
        "market": "fr",
        "asins": ["B07WR8JKKP", "B07WNHC2DP"]
    },
    {
        "market": "it",
        "asins": ["B07X5BWRFB"]
    }
]
```

Input rules:

-   Each market may appear only once.
-   Every ASIN must contain exactly 10 uppercase letters or digits.
-   ASINs must be unique within their market.
-   The enabled `.json` file should contain a conservative test subset before a large run.
-   [`input/Smartbox_2026.json.disabled`](input/Smartbox_2026.json.disabled) contains the full prepared dataset and is ignored by the build until deliberately promoted.

| Market | Amazon store  | Listing language requested  |
| ------ | ------------- | --------------------------- |
| `fr`   | amazon.fr     | French                      |
| `it`   | amazon.it     | Italian                     |
| `es`   | amazon.es     | Spanish                     |
| `de`   | amazon.de     | German                      |
| `be`   | amazon.com.be | Dutch, with French fallback |
| `nl`   | amazon.nl     | Dutch                       |

## Build the dataset and report

```bash
npm run build
```

The command validates the input, resumes any completed work, fetches missing Amazon data, requests missing or outdated DeepSeek suggestions, downloads report assets, and generates the website.

The main output is:

```text
output/Smartbox_2026/
├── index.html
└── assets/
    ├── app.css
    ├── app.js
    ├── data.json
    ├── numberly-logo.svg
    └── product-images/
```

Open [`output/Smartbox_2026/index.html`](output/Smartbox_2026/index.html) directly in a browser. No web server or internet connection is required to browse a completed report.

On macOS, for example:

```bash
open output/Smartbox_2026/index.html
```

The generated `assets/data.json` preserves the deterministic output structure:

```ts
type Output = Array<{
    market: Market;
    products: Array<{
        asin: string;
        title: string;
        productFeatures: string[];
        description: string;
        productImageUrl: string;
        reviews: {
            overallRating: number;
            totalCount: number;
            items: Array<{
                rating: 1 | 2 | 3 | 4 | 5;
                title: string | null;
                comment: string;
            }>;
        };
        suggestions: {
            title: { value: string; reasoning: string };
            productFeatures: { value: string[]; reasoning: string };
            description: { value: string; reasoning: string };
        };
        suggestionPromptVersion: number;
    }>;
}>;
```

## The DeepSeek prompt

The complete, versioned system prompt is maintained in [`src/prompts/product-optimization.ts`](src/prompts/product-optimization.ts). Keeping it separate makes the editorial policy easy to inspect, review, and evolve independently from the API client.

The prompt is designed around several principles:

-   **Conversion, not congratulations.** DeepSeek must materially improve every field and may not return an unchanged listing or claim that no work is needed.
-   **Four shopper decisions.** Copy is organized around recognition, relevance, confidence, and desire.
-   **Amazon-aware structure.** Titles are constrained to 75 characters, while secondary decision details move into three to five scannable feature bullets.
-   **Reviews as prioritization signals.** Review titles and comments help surface customer vocabulary, valued benefits, uncertainties, and objections. They are never treated as verified product facts.
-   **No invented claims.** Suggested benefits must follow conservatively from facts already present in the listing.
-   **Language separation.** Suggested listing copy remains in the source market language; concise editorial reasoning is returned in English.
-   **Auditable output.** Each rationale names the concrete changes and the expected improvement to discoverability, comprehension, confidence, or conversion.

DeepSeek runs in high-effort thinking mode and returns strict JSON. Deterministic validation rejects malformed responses, unchanged fields, titles over the current limit, invalid feature counts, and complacent reasoning. Failed validations are retried before anything is saved.

Changing the prompt version invalidates only cached AI suggestions. Previously scraped Amazon data remains reusable, so a prompt iteration does not require re-requesting every product page.

## Accessibility and localization

The report interface is English and the document root uses `lang="en"`. Product titles, features, descriptions, and customer reviews are wrapped in market-specific BCP 47 language attributes so assistive technology can switch pronunciation correctly without adding visible language labels to the interface.

## Useful commands

| Command                | Purpose                                            |
| ---------------------- | -------------------------------------------------- |
| `npm run build`        | Process the input and generate the complete report |
| `npm run format`       | Format TypeScript, TSX, JSON, and Markdown files   |
| `npm run format:check` | Verify formatting without changing files           |
| `npx tsc --noEmit`     | Run the TypeScript type checker                    |

## Project structure

```text
assets/                         README logo and screenshots
input/                          Enabled and full ASIN datasets
sample/                         Source spreadsheets and samples
src/
├── amazon.ts                   Serialized Amazon fetch and parser
├── deepseek.ts                 DeepSeek client and response validation
├── external-request.ts         Global external-request mutex
├── index.ts                    Resumable processing pipeline
├── prompts/
│   └── product-optimization.ts Versioned conversion prompt
├── report/                     React/Tailwind/Shadcn-style static report
└── schemas.ts                  Runtime schemas and TypeScript types
output/Smartbox_2026/           Generated self-contained website
.cache/                         Cached pages, images, and temporary files
```

## Operational notes

-   Start with a small enabled input before processing the full `.disabled` dataset.
-   Requests are sequential by design; do not parallelize the Amazon or DeepSeek loops.
-   A high aggregate rating does not mean a listing is already optimized.
-   Extracted reviews are qualitative context, not a statistically complete review corpus.
-   AI suggestions should be reviewed by a person before publishing. Conversion impact can only be confirmed with marketplace performance data or controlled testing.
