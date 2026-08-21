import type { Market } from "./schemas.js";

const countryNames: Record<Market, string[]> = {
    fr: ["france", "francia", "frankreich"],
    it: ["italy", "italia", "italie", "italien"],
    es: ["spain", "españa", "espagne", "spagna", "spanien"],
    de: ["germany", "germania", "allemagne", "deutschland", "duitsland"],
    be: ["belgium", "belgique", "belgië", "belgie", "belgio", "belgien"],
    nl: ["netherlands", "nederland", "pays-bas", "paesi bassi", "niederlande"]
};

const countriesOutsideSupportedMarkets = [
    "united kingdom",
    "regno unito",
    "royaume-uni",
    "vereinigtes königreich",
    "verenigd koninkrijk",
    "united states",
    "stati uniti",
    "états-unis",
    "estados unidos",
    "vereinigte staaten"
];

function getExcludedCountries(market: Market): string[] {
    return [
        ...Object.entries(countryNames)
            .filter(([candidate]) => candidate !== market)
            .flatMap(([, names]) => names),
        ...countriesOutsideSupportedMarkets
    ];
}

export type AmazonMarketplace = {
    domain: string;
    language: string;
    languageTag: string;
    excludedCountries: string[];
};

export const amazonMarketplaces: Record<Market, AmazonMarketplace> = {
    fr: {
        domain: "amazon.fr",
        language: "fr-FR,fr;q=0.9,en;q=0.5",
        languageTag: "fr-FR",
        excludedCountries: getExcludedCountries("fr")
    },
    it: {
        domain: "amazon.it",
        language: "it-IT,it;q=0.9,en;q=0.5",
        languageTag: "it-IT",
        excludedCountries: getExcludedCountries("it")
    },
    es: {
        domain: "amazon.es",
        language: "es-ES,es;q=0.9,en;q=0.5",
        languageTag: "es-ES",
        excludedCountries: getExcludedCountries("es")
    },
    de: {
        domain: "amazon.de",
        language: "de-DE,de;q=0.9,en;q=0.5",
        languageTag: "de-DE",
        excludedCountries: getExcludedCountries("de")
    },
    be: {
        domain: "amazon.com.be",
        language: "nl-BE,nl;q=0.9,fr-BE;q=0.8,fr;q=0.7,en;q=0.5",
        languageTag: "nl-BE",
        excludedCountries: getExcludedCountries("be")
    },
    nl: {
        domain: "amazon.nl",
        language: "nl-NL,nl;q=0.9,en;q=0.5",
        languageTag: "nl-NL",
        excludedCountries: getExcludedCountries("nl")
    }
};

export function getAmazonProductUrl(market: Market, asin: string): string {
    return `https://www.${amazonMarketplaces[market].domain}/dp/${asin}`;
}
