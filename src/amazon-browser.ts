import { mkdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import puppeteer, { type Browser, type Page } from "puppeteer";
import { amazonMarketplaces } from "./amazon-marketplaces.js";
import type { Market } from "./schemas.js";

const AMAZON_BROWSER_PROFILE = path.resolve(".cache/amazon-browser-profile");

let browserPromise: Promise<Browser> | undefined;

async function launchAmazonBrowser(): Promise<Browser> {
    await mkdir(AMAZON_BROWSER_PROFILE, { recursive: true });

    console.log("    Opening the dedicated Amazon browser session...");
    const browser = await puppeteer.launch({
        headless: false,
        userDataDir: AMAZON_BROWSER_PROFILE,
        defaultViewport: { width: 1440, height: 1_000 },
        args: ["--no-first-run", "--no-default-browser-check"]
    });

    browser.once("disconnected", () => {
        browserPromise = undefined;
    });

    return browser;
}

export async function getAmazonBrowser(): Promise<Browser> {
    browserPromise ??= launchAmazonBrowser();
    return browserPromise;
}

export async function createAmazonPage(market: Market): Promise<Page> {
    const browser = await getAmazonBrowser();
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({
        "accept-language": amazonMarketplaces[market].language
    });
    page.setDefaultNavigationTimeout(60_000);
    return page;
}

type AmazonInterruption = "CAPTCHA or automated-traffic challenge" | "Amazon sign-in";

async function detectAmazonInterruption(page: Page): Promise<AmazonInterruption | undefined> {
    const url = page.url().toLowerCase();
    if (url.includes("/ap/signin") || url.includes("/ap/cvf/")) {
        return "Amazon sign-in";
    }

    const captcha = await page.$(
        '#captchacharacters, form[action*="validateCaptcha"], form[action*="validatecaptcha"]'
    );
    if (captcha) return "CAPTCHA or automated-traffic challenge";

    const bodyText = await page.evaluate(() => document.body?.innerText.toLowerCase() ?? "");
    if (
        bodyText.includes("enter the characters you see below") ||
        bodyText.includes("saisissez les caractères que vous voyez ci-dessous") ||
        bodyText.includes("inserisci i caratteri che vedi qui sotto") ||
        bodyText.includes("introduce los caracteres que aparecen a continuación") ||
        bodyText.includes("geben sie die zeichen ein, die sie unten sehen") ||
        bodyText.includes("voer de tekens in die u hieronder ziet")
    ) {
        return "CAPTCHA or automated-traffic challenge";
    }

    return undefined;
}

async function waitForOperator(message: string): Promise<void> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error(
            `${message} Re-run this command in an interactive terminal, or run npm run amazon:login first.`
        );
    }

    const readline = createInterface({ input: process.stdin, output: process.stdout });
    try {
        await readline.question(
            "    Resolve it in the Amazon browser, then press Enter here to continue: "
        );
    } finally {
        readline.close();
    }
}

export async function waitForAmazonAccess(page: Page, market: Market, asin: string): Promise<void> {
    for (;;) {
        const interruption = await detectAmazonInterruption(page);
        if (!interruption) return;

        await page.bringToFront();
        const message = `Amazon requires ${interruption} for ${market}/${asin}.`;
        console.warn(`\n    ${message}`);
        await waitForOperator(message);

        if (page.isClosed()) {
            throw new Error("The Amazon browser tab was closed before the challenge was resolved");
        }
    }
}

export async function closeAmazonBrowser(): Promise<void> {
    const pendingBrowser = browserPromise;
    browserPromise = undefined;
    if (!pendingBrowser) return;

    try {
        const browser = await pendingBrowser;
        if (browser.connected) await browser.close();
    } catch {
        // The operator may already have closed the browser window.
    }
}

export const AMAZON_BROWSER_PROFILE_PATH = AMAZON_BROWSER_PROFILE;
