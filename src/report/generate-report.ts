import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { runExternalRequest } from "../external-request.js";
import type { StoredOutput } from "../schemas.js";

const executeFile = promisify(execFile);
const LOGO_URL = "https://numberly.com/assets/numberly-logo.eeb462ba.svg";
const REPORT_CACHE_DIRECTORY = path.resolve(".cache/report");
const CACHED_LOGO_PATH = path.join(REPORT_CACHE_DIRECTORY, "numberly-logo.svg");
const CACHED_PRODUCT_IMAGES_DIRECTORY = path.join(REPORT_CACHE_DIRECTORY, "product-images");

function escapeHtmlText(value: string): string {
    return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function createIndexHtml(reportTitle: string): string {
    return `<!doctype html>
<html lang="en">
    <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta name="color-scheme" content="light dark" />
        <meta name="theme-color" content="#008099" />
        <title>Review Genius 2.0 · ${escapeHtmlText(reportTitle)}</title>
        <script>
            try {
                const savedTheme = localStorage.getItem("review-genius-theme");
                const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
                document.documentElement.classList.toggle("dark", savedTheme === "dark" || (!savedTheme && prefersDark));
            } catch {}
        </script>
        <link rel="stylesheet" href="./assets/app.css" />
    </head>
    <body>
        <div id="root"></div>
        <noscript>Review Genius 2.0 requires JavaScript to navigate the report.</noscript>
        <script src="./assets/app.js"></script>
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

async function createLocalReportData(
    data: StoredOutput,
    assetsDirectory: string
): Promise<StoredOutput> {
    const localData = structuredClone(data);

    for (const group of localData.markets) {
        for (const product of group.products) {
            const relativeImagePath = `product-images/${group.market}/${product.asin}.jpg`;
            const cachedImagePath = path.join(
                CACHED_PRODUCT_IMAGES_DIRECTORY,
                group.market,
                `${product.asin}.jpg`
            );
            const outputImagePath = path.join(assetsDirectory, relativeImagePath);
            let image = await readCachedImage(cachedImagePath);

            if (image === undefined) {
                image = await runExternalRequest(async () => {
                    const response = await fetch(product.productImageUrl, {
                        signal: AbortSignal.timeout(30_000)
                    });
                    if (!response.ok) {
                        throw new Error(
                            `Product image for ${group.market}/${product.asin} returned HTTP ${response.status}`
                        );
                    }
                    if (!response.headers.get("content-type")?.startsWith("image/")) {
                        throw new Error(
                            `Product image for ${group.market}/${product.asin} was not an image`
                        );
                    }

                    return new Uint8Array(await response.arrayBuffer());
                });

                if (image.byteLength < 100) {
                    throw new Error(`Product image for ${group.market}/${product.asin} was empty`);
                }

                await mkdir(path.dirname(cachedImagePath), { recursive: true });
                await writeFile(cachedImagePath, image);
            }

            await mkdir(path.dirname(outputImagePath), { recursive: true });
            await writeFile(outputImagePath, image);
            product.productImageUrl = `./assets/${relativeImagePath}`;
        }
    }

    return localData;
}

export async function generateReport(data: StoredOutput, reportDirectory: string): Promise<void> {
    const assetsDirectory = path.join(reportDirectory, "assets");
    await mkdir(assetsDirectory, { recursive: true });
    await ensureLogoIsCached();
    const localReportData = await createLocalReportData(data, assetsDirectory);

    await Promise.all([
        writeFile(path.join(reportDirectory, "index.html"), createIndexHtml(data.title)),
        writeFile(path.join(assetsDirectory, "data.json"), `${JSON.stringify(data, null, 4)}\n`),
        copyFile(CACHED_LOGO_PATH, path.join(assetsDirectory, "numberly-logo.svg")),
        build({
            entryPoints: [path.resolve("src/report/main.tsx")],
            outfile: path.join(assetsDirectory, "app.js"),
            bundle: true,
            minify: true,
            sourcemap: false,
            legalComments: "none",
            platform: "browser",
            format: "iife",
            target: ["es2022"],
            define: {
                __REPORT_DATA__: JSON.stringify(localReportData)
            }
        }),
        executeFile(
            path.resolve("node_modules/.bin/tailwindcss"),
            [
                "--input",
                path.resolve("src/report/styles.css"),
                "--output",
                path.join(assetsDirectory, "app.css"),
                "--minify"
            ],
            { cwd: path.resolve(".") }
        )
    ]);
}
