import { createInterface } from "node:readline/promises";
import { closeAmazonBrowser, createAmazonPage } from "./amazon-browser.js";
import { amazonMarketplaces } from "./amazon-marketplaces.js";
import type { Market } from "./schemas.js";

const markets = Object.keys(amazonMarketplaces) as Market[];

async function main(): Promise<void> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error("Amazon login must be run from an interactive terminal");
    }

    console.log("Opening one account page for every configured Amazon marketplace.");
    console.log("Sign in where needed. This dedicated session is stored only under .cache/.\n");

    try {
        for (const market of markets) {
            const marketplace = amazonMarketplaces[market];
            const page = await createAmazonPage(market);
            await page.goto(`https://www.${marketplace.domain}/gp/css/homepage.html`, {
                waitUntil: "domcontentloaded"
            });
            console.log(`  ${market}: opened ${marketplace.domain}`);
        }

        const readline = createInterface({ input: process.stdin, output: process.stdout });
        try {
            await readline.question(
                "\nFinish signing in (and solve any Amazon challenge), then press Enter here to save and close: "
            );
        } finally {
            readline.close();
        }
    } finally {
        await closeAmazonBrowser();
    }

    console.log("Amazon session saved. You can now run npm run build.");
}

main().catch(error => {
    console.error(`\nAmazon login failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
});
