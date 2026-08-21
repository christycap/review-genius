import { execFile } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import sharp from "sharp";
import type { ReportAiConfig } from "../ai.js";
import { runExternalRequest } from "../external-request.js";
import type { StoredOutput } from "../schemas.js";

const executeFile = promisify(execFile);
const LOGO_URL = "https://numberly.com/assets/numberly-logo.eeb462ba.svg";
const FAVICON_URL = "https://numberly.com/favicon.ico";
const REPORT_CACHE_DIRECTORY = path.resolve(".cache/report");
const CACHED_LOGO_PATH = path.join(REPORT_CACHE_DIRECTORY, "numberly-logo.svg");
const CACHED_FAVICON_PATH = path.join(REPORT_CACHE_DIRECTORY, "numberly-favicon.ico");
const CACHED_PRODUCT_IMAGES_DIRECTORY = path.join(REPORT_CACHE_DIRECTORY, "product-images");
const OPTIMIZED_PRODUCT_IMAGES_DIRECTORY = path.join(REPORT_CACHE_DIRECTORY, "optimized-product-images");
const CACHED_STYLES_PATH = path.join(REPORT_CACHE_DIRECTORY, "app.css");
const PRODUCT_IMAGE_MAXIMUM_SIZE = 640;

function escapeHtmlText(value: string): string {
    return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeInlineScript(value: string): string {
    return value.replace(/<\/script/gi, "<\\/script");
}

function escapeInlineStyle(value: string): string {
    return value.replace(/<\/style/gi, "<\\/style");
}

function serializeForJavaScript(value: unknown): string {
    return JSON.stringify(value)
        .replaceAll("<", "\\u003c")
        .replaceAll(">", "\\u003e")
        .replaceAll("&", "\\u0026")
        .replaceAll("\u2028", "\\u2028")
        .replaceAll("\u2029", "\\u2029");
}

function createDataUrl(mimeType: string, value: Uint8Array | string): string {
    return `data:${mimeType};base64,${Buffer.from(value).toString("base64")}`;
}

function createSingleFileHtml(
    reportTitle: string,
    faviconUrl: string,
    styles: string,
    applicationJavaScript: string
): string {
    return `<!doctype html>
<html lang="en">
    <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta name="color-scheme" content="light dark" />
        <meta name="theme-color" content="#008099" />
        <title>Review Genius 2.0 · ${escapeHtmlText(reportTitle)}</title>
        <link rel="icon" type="image/x-icon" href="${faviconUrl}" />
        <script>
            try {
                const savedTheme = localStorage.getItem("review-genius-theme");
                const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
                document.documentElement.classList.toggle("dark", savedTheme === "dark" || (!savedTheme && prefersDark));
            } catch {}
        </script>
        <style>${escapeInlineStyle(styles)}</style>
    </head>
    <body>
        <div id="root"></div>
        <noscript>Review Genius 2.0 requires JavaScript to navigate the report.</noscript>
        <script>${escapeInlineScript(applicationJavaScript)}</script>
    </body>
</html>
`;
}

async function ensureLogoIsCached(): Promise<void> {
    try {
        const cached = await readFile(CACHED_LOGO_PATH, "utf8");
        if (cached.trimStart().startsWith("<svg")) return;
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
            throw error;
        }
    }

    const logo = await runExternalRequest(async () => {
        const response = await fetch(LOGO_URL, { signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error(`Numberly logo returned HTTP ${response.status}`);
        return response.text();
    });

    if (!logo.trimStart().startsWith("<svg")) {
        throw new Error("Numberly logo response was not a valid SVG document");
    }

    await mkdir(REPORT_CACHE_DIRECTORY, { recursive: true });
    await writeFile(CACHED_LOGO_PATH, logo);
}

function isIcoFile(value: Uint8Array): boolean {
    return value.byteLength >= 6 && value[0] === 0 && value[1] === 0 && value[2] === 1 && value[3] === 0;
}

async function ensureFaviconIsCached(): Promise<void> {
    try {
        const cached = await readFile(CACHED_FAVICON_PATH);
        if (isIcoFile(cached)) return;
    } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
            throw error;
        }
    }

    const favicon = await runExternalRequest(async () => {
        const response = await fetch(FAVICON_URL, { signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error(`Numberly favicon returned HTTP ${response.status}`);
        return new Uint8Array(await response.arrayBuffer());
    });

    if (!isIcoFile(favicon)) {
        throw new Error("Numberly favicon response was not a valid ICO file");
    }

    await mkdir(REPORT_CACHE_DIRECTORY, { recursive: true });
    await writeFile(CACHED_FAVICON_PATH, favicon);
}

async function readCachedImage(filePath: string): Promise<Uint8Array | undefined> {
    try {
        const image = await readFile(filePath);
        return image.byteLength >= 100 ? image : undefined;
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") {
            return undefined;
        }
        throw error;
    }
}

async function readOrDownloadProductImage(
    market: string,
    asin: string,
    imageUrl: string
): Promise<Uint8Array> {
    const cachedImagePath = path.join(CACHED_PRODUCT_IMAGES_DIRECTORY, market, `${asin}.jpg`);
    const cached = await readCachedImage(cachedImagePath);
    if (cached) return cached;

    const image = await runExternalRequest(async () => {
        const response = await fetch(imageUrl, { signal: AbortSignal.timeout(30_000) });
        if (!response.ok) {
            throw new Error(`Product image for ${market}/${asin} returned HTTP ${response.status}`);
        }
        if (!response.headers.get("content-type")?.startsWith("image/")) {
            throw new Error(`Product image for ${market}/${asin} was not an image`);
        }

        return new Uint8Array(await response.arrayBuffer());
    });

    if (image.byteLength < 100) {
        throw new Error(`Product image for ${market}/${asin} was empty`);
    }

    await mkdir(path.dirname(cachedImagePath), { recursive: true });
    await writeFile(cachedImagePath, image);
    return image;
}

async function createEmbeddedProductImage(
    market: string,
    asin: string,
    imageUrl: string
): Promise<string> {
    const optimizedImagePath = path.join(OPTIMIZED_PRODUCT_IMAGES_DIRECTORY, market, `${asin}.webp`);
    let optimizedImage = await readCachedImage(optimizedImagePath);

    if (!optimizedImage) {
        const sourceImage = await readOrDownloadProductImage(market, asin, imageUrl);

        try {
            optimizedImage = await sharp(sourceImage)
                .rotate()
                .resize({
                    width: PRODUCT_IMAGE_MAXIMUM_SIZE,
                    height: PRODUCT_IMAGE_MAXIMUM_SIZE,
                    fit: "inside",
                    withoutEnlargement: true
                })
                .webp({ quality: 82, effort: 4 })
                .toBuffer();
        } catch (error) {
            throw new Error(
                `Could not optimize the product image for ${market}/${asin}: ${
                    error instanceof Error ? error.message : String(error)
                }`
            );
        }

        await mkdir(path.dirname(optimizedImagePath), { recursive: true });
        await writeFile(optimizedImagePath, optimizedImage);
    }

    return createDataUrl("image/webp", optimizedImage);
}

async function createEmbeddedReportData(data: StoredOutput): Promise<StoredOutput> {
    const embeddedData = structuredClone(data);

    for (const group of embeddedData.markets) {
        for (const product of group.products) {
            delete product.suggestionPromptVersion;
            delete product.suggestionProvider;
            delete product.suggestionModel;
            delete product.sentimentPromptVersion;
            delete product.sentimentProvider;
            delete product.sentimentModel;
            delete product.sentimentSourceHash;
            delete product.translationPromptVersion;
            delete product.translationProvider;
            delete product.translationModel;
            delete product.translationSourceHash;
            product.productImageUrl = await createEmbeddedProductImage(
                group.market,
                product.asin,
                product.productImageUrl
            );
        }
    }

    return embeddedData;
}

async function compileReportJavaScript(
    data: StoredOutput,
    aiConfig: ReportAiConfig,
    logoUrl: string
): Promise<string> {
    const result = await build({
        entryPoints: [path.resolve("src/report/main.tsx")],
        bundle: true,
        minify: true,
        sourcemap: false,
        legalComments: "none",
        platform: "browser",
        format: "iife",
        target: ["es2022"],
        write: false,
        define: {
            __REPORT_DATA__: serializeForJavaScript(data),
            __REPORT_AI_CONFIG__: serializeForJavaScript(aiConfig),
            __REPORT_LOGO_URL__: serializeForJavaScript(logoUrl)
        }
    });
    const output =
        result.outputFiles?.find(file => file.path.endsWith(".js")) ?? result.outputFiles?.[0];
    if (!output) throw new Error("esbuild did not produce the report JavaScript");
    return output.text;
}

async function compileReportStyles(): Promise<string> {
    await mkdir(REPORT_CACHE_DIRECTORY, { recursive: true });
    await executeFile(
        path.resolve("node_modules/.bin/tailwindcss"),
        ["--input", path.resolve("src/report/styles.css"), "--output", CACHED_STYLES_PATH, "--minify"],
        { cwd: path.resolve(".") }
    );
    return readFile(CACHED_STYLES_PATH, "utf8");
}

export async function generateReport(
    data: StoredOutput,
    reportOutputPath: string,
    aiConfig: ReportAiConfig
): Promise<void> {
    await ensureLogoIsCached();
    await ensureFaviconIsCached();

    const [logo, favicon] = await Promise.all([
        readFile(CACHED_LOGO_PATH, "utf8"),
        readFile(CACHED_FAVICON_PATH)
    ]);
    const embeddedData = await createEmbeddedReportData(data);
    const logoUrl = createDataUrl("image/svg+xml", logo);
    const faviconUrl = createDataUrl("image/x-icon", favicon);
    const [applicationJavaScript, styles] = await Promise.all([
        compileReportJavaScript(embeddedData, aiConfig, logoUrl),
        compileReportStyles()
    ]);
    const html = createSingleFileHtml(data.title, faviconUrl, styles, applicationJavaScript);
    const temporaryOutputPath = `${reportOutputPath}.tmp`;

    await mkdir(path.dirname(reportOutputPath), { recursive: true });
    await writeFile(temporaryOutputPath, html);
    await rename(temporaryOutputPath, reportOutputPath);
}
