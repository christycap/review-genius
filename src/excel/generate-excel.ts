import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import ExcelJS, { type Cell, type CellValue, type Row, type Worksheet } from "exceljs";
import sharp from "sharp";
import { getAmazonProductUrl } from "../amazon-marketplaces.js";
import { runExternalRequest } from "../external-request.js";
import { createReviewKey } from "../review-key.js";
import { stripAmazonRatingFromReviewTitle } from "../review-title.js";
import type { Market, StoredOutput, StoredProduct } from "../schemas.js";

const EXCEL_CACHE_DIRECTORY = path.resolve(".cache/excel");
const EXCEL_PRODUCT_IMAGES_DIRECTORY = path.join(EXCEL_CACHE_DIRECTORY, "product-images");
const REPORT_PRODUCT_IMAGES_DIRECTORY = path.resolve(".cache/report/product-images");
const EXCEL_CELL_CHARACTER_LIMIT = 32_767;
const WORKBOOK_FONT = "Arial";
const REPORT_NAME = "Review Genius";
const MARKET_NAMES: Record<Market, string> = {
    fr: "France",
    it: "Italy",
    es: "Spain",
    de: "Germany",
    be: "Belgium",
    nl: "Netherlands"
};

const COLORS = {
    navy: "FF071821",
    navyMuted: "FF16303B",
    teal: "FF12B8CB",
    tealDark: "FF087E90",
    tealPale: "FFE7F8FA",
    bluePale: "FFEAF3FC",
    yellowPale: "FFFFF6D8",
    green: "FF13795B",
    greenPale: "FFE6F5EF",
    red: "FFB42318",
    redPale: "FFFCE8E6",
    grey: "FF63747D",
    greyPale: "FFF3F6F7",
    border: "FFD3DEE2",
    white: "FFFFFFFF"
} as const;

async function readCachedImage(filePath: string): Promise<Buffer | undefined> {
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

function decodeImageDataUrl(imageUrl: string): Buffer | undefined {
    const match = /^data:image\/[a-z0-9.+-]+;base64,(.+)$/is.exec(imageUrl);
    if (!match) return undefined;

    const image = Buffer.from(match[1], "base64");
    return image.byteLength >= 100 ? image : undefined;
}

async function loadProductImage(market: Market, asin: string, imageUrl: string): Promise<Buffer> {
    const reportImagePath = path.join(REPORT_PRODUCT_IMAGES_DIRECTORY, market, `${asin}.jpg`);
    const reportImage = await readCachedImage(reportImagePath);
    if (reportImage) return reportImage;

    const embeddedImage = decodeImageDataUrl(imageUrl);
    if (embeddedImage) return embeddedImage;

    return runExternalRequest(async () => {
        const response = await fetch(imageUrl, { signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if (!response.headers.get("content-type")?.startsWith("image/")) {
            throw new Error("the response was not an image");
        }

        const image = Buffer.from(await response.arrayBuffer());
        if (image.byteLength < 100) throw new Error("the response was empty");
        return image;
    });
}

async function prepareProductImage(market: Market, product: StoredProduct): Promise<string | undefined> {
    const imagePath = path.join(EXCEL_PRODUCT_IMAGES_DIRECTORY, market, `${product.asin}.png`);
    if (await readCachedImage(imagePath)) return imagePath;

    try {
        const sourceImage = await loadProductImage(market, product.asin, product.productImageUrl);
        const image = await sharp(sourceImage)
            .rotate()
            .resize({
                width: 480,
                height: 480,
                fit: "contain",
                background: { r: 255, g: 255, b: 255, alpha: 1 }
            })
            .png({ compressionLevel: 9 })
            .toBuffer();

        await mkdir(path.dirname(imagePath), { recursive: true });
        await writeFile(imagePath, image);
        return imagePath;
    } catch (error) {
        console.warn(
            `    Product image omitted from the ${market} workbook for ${product.asin}: ${
                error instanceof Error ? error.message : String(error)
            }`
        );
        return undefined;
    }
}

async function registerProductImages(
    workbook: ExcelJS.Workbook,
    market: Market,
    products: StoredProduct[]
): Promise<Map<string, number>> {
    const images = new Map<string, number>();

    for (const product of products) {
        const imagePath = await prepareProductImage(market, product);
        if (imagePath) {
            images.set(product.asin, workbook.addImage({ filename: imagePath, extension: "png" }));
        }
    }

    return images;
}

function countCharacters(value: string): number {
    return Array.from(value).length;
}

function safeCellText(value: string | null | undefined): string {
    if (!value) return "";

    const cleaned = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");
    const characters = Array.from(cleaned);
    if (characters.length <= EXCEL_CELL_CHARACTER_LIMIT) return cleaned;

    const suffix = "\n[… truncated to fit Excel's cell limit]";
    return `${characters
        .slice(0, EXCEL_CELL_CHARACTER_LIMIT - countCharacters(suffix))
        .join("")}${suffix}`;
}

function formatList(values: string[] | undefined): string {
    return values?.map((value, index) => `${index + 1}. ${value}`).join("\n\n") ?? "";
}

function countListCharacters(values: string[]): number {
    return values.reduce((total, value) => total + countCharacters(value), 0);
}

function formatSelectionReason(
    reason: StoredProduct["reviews"]["items"][number]["selectionReason"]
): string {
    if (reason === "embedded-top") return "Amazon top review";
    if (reason === "critical") return "Critical-review coverage";
    return "Recent review";
}

function styleBorder(cell: Cell): void {
    cell.border = {
        top: { style: "thin", color: { argb: COLORS.border } },
        left: { style: "thin", color: { argb: COLORS.border } },
        bottom: { style: "thin", color: { argb: COLORS.border } },
        right: { style: "thin", color: { argb: COLORS.border } }
    };
}

function styleBanner(worksheet: Worksheet, title: string, subtitle: string, lastColumn: number): void {
    worksheet.mergeCells(1, 1, 1, lastColumn);
    worksheet.mergeCells(2, 1, 2, lastColumn);

    const titleCell = worksheet.getCell(1, 1);
    titleCell.value = title;
    titleCell.font = { bold: true, color: { argb: COLORS.white }, size: 20 };
    titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.tealDark } };
    titleCell.alignment = { vertical: "middle" };
    worksheet.getRow(1).height = 34;

    const subtitleCell = worksheet.getCell(2, 1);
    subtitleCell.value = subtitle;
    subtitleCell.font = { bold: true, color: { argb: COLORS.white }, size: 12 };
    subtitleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.navy } };
    subtitleCell.alignment = { vertical: "middle" };
    worksheet.getRow(2).height = 25;
}

function styleTableHeader(row: Row, lastColumn: number): void {
    row.height = 32;

    for (let column = 1; column <= lastColumn; column += 1) {
        const cell = row.getCell(column);
        cell.font = { bold: true, color: { argb: COLORS.white }, size: 10 };
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.navyMuted } };
        cell.alignment = { vertical: "middle", wrapText: true };
        styleBorder(cell);
    }
}

function styleDataRow(row: Row, lastColumn: number, fillColor?: string): void {
    for (let column = 1; column <= lastColumn; column += 1) {
        const cell = row.getCell(column);
        cell.font = { color: { argb: COLORS.navy }, size: 10 };
        cell.alignment = { vertical: "top", wrapText: true };
        if (fillColor) {
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: fillColor } };
        }
        styleBorder(cell);
    }
}

function styleMetadataLabel(cell: Cell): void {
    cell.font = { bold: true, color: { argb: COLORS.white }, size: 10 };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.navyMuted } };
    cell.alignment = { vertical: "middle", wrapText: true };
    styleBorder(cell);
}

function styleMetadataValue(cell: Cell): void {
    cell.font = { color: { argb: COLORS.navy }, size: 10 };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.greyPale } };
    cell.alignment = { vertical: "middle", wrapText: true };
    styleBorder(cell);
}

function applyWorkbookFont(workbook: ExcelJS.Workbook): void {
    workbook.eachSheet(worksheet => {
        worksheet.eachRow({ includeEmpty: true }, row => {
            row.eachCell({ includeEmpty: true }, cell => {
                cell.font = { ...cell.font, name: WORKBOOK_FONT };
            });
        });
    });
}

function internalSheetLink(sheetName: string, text: string): CellValue {
    return {
        text,
        hyperlink: `#'${sheetName.replaceAll("'", "''")}'!A1`,
        tooltip: `Open ${sheetName}`
    };
}

function addOverviewSheet(
    workbook: ExcelJS.Workbook,
    output: StoredOutput,
    market: Market,
    products: StoredProduct[],
    productSheetNames: Map<string, string>,
    productImages: Map<string, number>
): void {
    const worksheet = workbook.addWorksheet("Overview", {
        properties: { tabColor: { argb: COLORS.teal } },
        views: [{ state: "frozen", ySplit: 4, topLeftCell: "A5", showGridLines: false }]
    });
    worksheet.columns = [
        { width: 13 },
        { width: 15 },
        { width: 18 },
        { width: 58 },
        { width: 58 },
        { width: 15 },
        { width: 16 },
        { width: 18 },
        { width: 14 },
        { width: 14 },
        { width: 18 }
    ];
    styleBanner(
        worksheet,
        REPORT_NAME,
        `${output.title} · ${MARKET_NAMES[market]} (${market}) · ${products.length} product${
            products.length === 1 ? "" : "s"
        }`,
        11
    );

    worksheet.mergeCells("A3:K3");
    worksheet.getCell("A3").value =
        "Use the product links to inspect Amazon listings and the analysis links to open the detailed recommendation for each ASIN.";
    worksheet.getCell("A3").font = { italic: true, color: { argb: COLORS.grey }, size: 10 };
    worksheet.getCell("A3").alignment = { vertical: "middle", wrapText: true };
    worksheet.getRow(3).height = 26;

    const header = worksheet.getRow(4);
    header.values = [
        "Product",
        "ASIN",
        "Amazon listing",
        "Original title (market language)",
        "Original title (English)",
        "Amazon rating",
        "Total reviews",
        "Extracted reviews",
        "Positive",
        "Negative",
        "Product analysis"
    ];
    styleTableHeader(header, 11);

    products.forEach((product, index) => {
        const classifications = product.reviewSentiment?.classifications ?? [];
        const positiveCount = classifications.filter(item => item.sentiment === "positive").length;
        const negativeCount = classifications.filter(item => item.sentiment === "negative").length;
        const row = worksheet.addRow([
            "",
            product.asin,
            {
                text: "Open on Amazon",
                hyperlink: getAmazonProductUrl(market, product.asin),
                tooltip: `Open ${product.asin} on Amazon`
            },
            safeCellText(product.title),
            safeCellText(product.englishTranslations?.original.title),
            product.reviews.overallRating,
            product.reviews.totalCount,
            product.reviews.items.length,
            positiveCount,
            negativeCount,
            internalSheetLink(productSheetNames.get(product.asin) ?? product.asin, "Open analysis")
        ]);
        row.height = 58;
        styleDataRow(row, 11, index % 2 === 0 ? COLORS.white : COLORS.greyPale);
        row.getCell(3).font = { color: { argb: COLORS.tealDark }, underline: true, size: 10 };
        row.getCell(11).font = {
            bold: true,
            color: { argb: COLORS.tealDark },
            underline: true,
            size: 10
        };
        row.getCell(6).numFmt = "0.0";
        row.getCell(6).alignment = { horizontal: "center", vertical: "middle" };
        [7, 8, 9, 10].forEach(column => {
            row.getCell(column).numFmt = "#,##0";
            row.getCell(column).alignment = { horizontal: "center", vertical: "middle" };
        });
        row.getCell(9).fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: COLORS.greenPale }
        };
        row.getCell(10).fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: COLORS.redPale }
        };

        const imageId = productImages.get(product.asin);
        if (imageId !== undefined) {
            worksheet.addImage(imageId, {
                tl: { col: 0.18, row: row.number - 0.92 },
                ext: { width: 52, height: 52 },
                editAs: "oneCell",
                hyperlinks: {
                    hyperlink: getAmazonProductUrl(market, product.asin),
                    tooltip: `Open ${product.asin} on Amazon`
                }
            });
        }
    });

    worksheet.autoFilter = { from: "A4", to: `K${Math.max(4, worksheet.rowCount)}` };
    worksheet.pageSetup = {
        orientation: "landscape",
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
        paperSize: 9,
        margins: { left: 0.25, right: 0.25, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 }
    };
    worksheet.headerFooter.oddFooter = `&L${REPORT_NAME}&C&A&RPage &P of &N`;
}

type CopyComparison = {
    field: string;
    original: string;
    originalEnglish: string;
    originalCharacters: number;
    suggested: string;
    suggestedEnglish: string;
    suggestedCharacters?: number;
    rationale: string;
};

function createCopyComparisons(product: StoredProduct): CopyComparison[] {
    const suggestions = product.suggestions;
    const translations = product.englishTranslations;

    return [
        {
            field: "Title",
            original: product.title,
            originalEnglish: translations?.original.title ?? "",
            originalCharacters: countCharacters(product.title),
            suggested: suggestions?.title.value ?? "",
            suggestedEnglish: translations?.suggestions.title ?? "",
            suggestedCharacters:
                suggestions === undefined ? undefined : countCharacters(suggestions.title.value),
            rationale: suggestions?.title.reasoning ?? ""
        },
        {
            field: "Product features",
            original: formatList(product.productFeatures),
            originalEnglish: formatList(translations?.original.productFeatures),
            originalCharacters: countListCharacters(product.productFeatures),
            suggested: formatList(suggestions?.productFeatures.value),
            suggestedEnglish: formatList(translations?.suggestions.productFeatures),
            suggestedCharacters:
                suggestions === undefined
                    ? undefined
                    : countListCharacters(suggestions.productFeatures.value),
            rationale: suggestions?.productFeatures.reasoning ?? ""
        },
        {
            field: "Description",
            original: product.description,
            originalEnglish: translations?.original.description ?? "",
            originalCharacters: countCharacters(product.description),
            suggested: suggestions?.description.value ?? "",
            suggestedEnglish: translations?.suggestions.description ?? "",
            suggestedCharacters:
                suggestions === undefined ? undefined : countCharacters(suggestions.description.value),
            rationale: suggestions?.description.reasoning ?? ""
        }
    ];
}

function addProductSheet(
    workbook: ExcelJS.Workbook,
    output: StoredOutput,
    market: Market,
    product: StoredProduct,
    sheetName: string,
    productImageId: number | undefined
): void {
    const worksheet = workbook.addWorksheet(sheetName, {
        properties: { tabColor: { argb: COLORS.teal } },
        views: [{ state: "frozen", ySplit: 8, topLeftCell: "A9", showGridLines: false }]
    });
    worksheet.columns = [
        { width: 20 },
        { width: 58 },
        { width: 58 },
        { width: 13 },
        { width: 58 },
        { width: 58 },
        { width: 13 },
        { width: 13 },
        { width: 58 }
    ];
    styleBanner(
        worksheet,
        `${REPORT_NAME} · ${product.asin}`,
        `${output.title} · ${MARKET_NAMES[market]} (${market})`,
        9
    );

    worksheet.mergeCells("A3:A7");
    worksheet.getCell("A3").fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: COLORS.white }
    };
    styleBorder(worksheet.getCell("A3"));
    if (productImageId !== undefined) {
        worksheet.addImage(productImageId, {
            tl: { col: 0.12, row: 2.18 },
            ext: { width: 118, height: 118 },
            editAs: "oneCell",
            hyperlinks: {
                hyperlink: getAmazonProductUrl(market, product.asin),
                tooltip: `Open ${product.asin} on Amazon`
            }
        });
    }

    worksheet.mergeCells("B3:I4");
    worksheet.getCell("B3").value = safeCellText(product.title);
    worksheet.getCell("B3").font = { bold: true, color: { argb: COLORS.navy }, size: 12 };
    worksheet.getCell("B3").alignment = { vertical: "middle", wrapText: true };
    worksheet.getCell("B3").fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: COLORS.tealPale }
    };
    styleBorder(worksheet.getCell("B3"));
    worksheet.getRow(3).height = 34;
    worksheet.getRow(4).height = 34;

    worksheet.mergeCells("B5:C5");
    worksheet.getCell("B5").value = internalSheetLink("Overview", "← Market overview");
    styleMetadataValue(worksheet.getCell("B5"));
    worksheet.getCell("B5").font = {
        bold: true,
        color: { argb: COLORS.tealDark },
        underline: true,
        size: 10
    };
    worksheet.mergeCells("D5:E5");
    worksheet.getCell("D5").value = {
        text: "Open the Amazon listing",
        hyperlink: getAmazonProductUrl(market, product.asin),
        tooltip: `Open ${product.asin} on Amazon`
    };
    styleMetadataValue(worksheet.getCell("D5"));
    worksheet.getCell("D5").font = {
        color: { argb: COLORS.tealDark },
        underline: true,
        size: 10
    };
    worksheet.getCell("F5").value = "Amazon rating";
    styleMetadataLabel(worksheet.getCell("F5"));
    worksheet.getCell("G5").value = product.reviews.overallRating;
    worksheet.getCell("G5").numFmt = "0.0";
    styleMetadataValue(worksheet.getCell("G5"));
    worksheet.getCell("H5").value = "Total reviews";
    styleMetadataLabel(worksheet.getCell("H5"));
    worksheet.getCell("I5").value = product.reviews.totalCount;
    worksheet.getCell("I5").numFmt = "#,##0";
    styleMetadataValue(worksheet.getCell("I5"));

    worksheet.getCell("B6").value = "ASIN";
    styleMetadataLabel(worksheet.getCell("B6"));
    worksheet.mergeCells("C6:D6");
    worksheet.getCell("C6").value = product.asin;
    styleMetadataValue(worksheet.getCell("C6"));
    worksheet.getCell("E6").value = "Market";
    styleMetadataLabel(worksheet.getCell("E6"));
    worksheet.getCell("F6").value = `${MARKET_NAMES[market]} (${market})`;
    styleMetadataValue(worksheet.getCell("F6"));
    worksheet.getCell("G6").value = "Extracted reviews";
    styleMetadataLabel(worksheet.getCell("G6"));
    worksheet.mergeCells("H6:I6");
    worksheet.getCell("H6").value = product.reviews.items.length;
    worksheet.getCell("H6").numFmt = "#,##0";
    styleMetadataValue(worksheet.getCell("H6"));
    worksheet.getRow(5).height = 28;
    worksheet.getRow(6).height = 28;
    worksheet.getRow(7).height = 12;

    const tableHeader = worksheet.getRow(8);
    tableHeader.values = [
        "Element",
        "Current copy (market language)",
        "Current copy (English)",
        "Current chars",
        "Suggested copy (market language)",
        "Suggested copy (English)",
        "Suggested chars",
        "Δ chars",
        "Recommendation rationale (English)"
    ];
    styleTableHeader(tableHeader, 9);

    createCopyComparisons(product).forEach((comparison, index) => {
        const difference =
            comparison.suggestedCharacters === undefined
                ? ""
                : comparison.suggestedCharacters - comparison.originalCharacters;
        const row = worksheet.addRow([
            comparison.field,
            safeCellText(comparison.original),
            safeCellText(comparison.originalEnglish),
            comparison.originalCharacters,
            safeCellText(comparison.suggested),
            safeCellText(comparison.suggestedEnglish),
            comparison.suggestedCharacters ?? "",
            difference,
            safeCellText(comparison.rationale)
        ]);
        row.height = index === 0 ? 90 : index === 1 ? 180 : 220;
        styleDataRow(row, 9, index % 2 === 0 ? COLORS.white : COLORS.greyPale);
        row.getCell(1).font = { bold: true, color: { argb: COLORS.navy }, size: 10 };
        row.getCell(3).fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: COLORS.bluePale }
        };
        row.getCell(5).fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: COLORS.tealPale }
        };
        row.getCell(6).fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: COLORS.bluePale }
        };
        row.getCell(9).fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: COLORS.yellowPale }
        };
        [4, 7, 8].forEach(column => {
            row.getCell(column).numFmt = "#,##0;[Red]-#,##0";
            row.getCell(column).alignment = { horizontal: "center", vertical: "middle" };
        });

        if (typeof difference === "number") {
            const deltaCell = row.getCell(8);
            deltaCell.font = {
                bold: true,
                color: {
                    argb: difference > 0 ? COLORS.red : difference < 0 ? COLORS.green : COLORS.grey
                },
                size: 10
            };
            deltaCell.fill = {
                type: "pattern",
                pattern: "solid",
                fgColor: {
                    argb:
                        difference > 0
                            ? COLORS.redPale
                            : difference < 0
                            ? COLORS.greenPale
                            : COLORS.greyPale
                }
            };
        }
    });

    const insightHeaderRow = 13;
    worksheet.mergeCells(insightHeaderRow, 1, insightHeaderRow, 9);
    const insightHeader = worksheet.getCell(insightHeaderRow, 1);
    insightHeader.value = "Review insights";
    insightHeader.font = { bold: true, color: { argb: COLORS.white }, size: 12 };
    insightHeader.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: COLORS.tealDark }
    };
    insightHeader.alignment = { vertical: "middle" };
    worksheet.getRow(insightHeaderRow).height = 28;

    const classifications = product.reviewSentiment?.classifications ?? [];
    const positiveCount = classifications.filter(item => item.sentiment === "positive").length;
    const negativeCount = classifications.filter(item => item.sentiment === "negative").length;
    const insightRows = [
        {
            label: "Overall sentiment",
            value:
                product.reviewSentiment?.overallSummary ??
                "Sentiment analysis is not available for this product."
        },
        {
            label: `Positive summary (${positiveCount})`,
            value:
                product.reviewSentiment?.positiveSummary ??
                "Positive sentiment analysis is not available for this product."
        },
        {
            label: `Negative summary (${negativeCount})`,
            value:
                product.reviewSentiment?.negativeSummary ??
                "Negative sentiment analysis is not available for this product."
        }
    ];

    insightRows.forEach((insight, index) => {
        const rowNumber = insightHeaderRow + index + 1;
        worksheet.getCell(rowNumber, 1).value = insight.label;
        styleMetadataLabel(worksheet.getCell(rowNumber, 1));
        worksheet.mergeCells(rowNumber, 2, rowNumber, 9);
        worksheet.getCell(rowNumber, 2).value = safeCellText(insight.value);
        styleMetadataValue(worksheet.getCell(rowNumber, 2));
        worksheet.getCell(rowNumber, 2).alignment = { vertical: "top", wrapText: true };
        worksheet.getRow(rowNumber).height = 88;
    });

    worksheet.pageSetup = {
        orientation: "landscape",
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
        paperSize: 9,
        printArea: "A1:I16",
        margins: { left: 0.25, right: 0.25, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 }
    };
    worksheet.headerFooter.oddFooter = `&L${REPORT_NAME}&C${product.asin}&RPage &P of &N`;
}

type ReviewExportEntry = {
    product: StoredProduct;
    review: StoredProduct["reviews"]["items"][number];
    reviewIndex: number;
};

function sortedReviewEntries(products: StoredProduct[]): ReviewExportEntry[] {
    return products.flatMap(product =>
        product.reviews.items
            .map((review, reviewIndex) => ({ product, review, reviewIndex }))
            .sort((left, right) => {
                const helpfulDifference = right.review.helpfulCount - left.review.helpfulCount;
                if (helpfulDifference !== 0) return helpfulDifference;

                const leftDate = left.review.date ?? "";
                const rightDate = right.review.date ?? "";
                const dateDifference = rightDate.localeCompare(leftDate);
                return dateDifference !== 0 ? dateDifference : left.reviewIndex - right.reviewIndex;
            })
    );
}

function addReviewsSheet(
    workbook: ExcelJS.Workbook,
    output: StoredOutput,
    market: Market,
    products: StoredProduct[]
): void {
    const worksheet = workbook.addWorksheet("Reviews", {
        properties: { tabColor: { argb: COLORS.navyMuted } },
        views: [
            {
                state: "frozen",
                xSplit: 2,
                ySplit: 4,
                topLeftCell: "C5",
                showGridLines: false
            }
        ]
    });
    worksheet.columns = [
        { width: 15 },
        { width: 13 },
        { width: 10 },
        { width: 14 },
        { width: 14 },
        { width: 17 },
        { width: 18 },
        { width: 42 },
        { width: 72 },
        { width: 42 },
        { width: 72 },
        { width: 24 },
        { width: 24 },
        { width: 15 },
        { width: 20 },
        { width: 25 },
        { width: 22 },
        { width: 18 }
    ];

    const reviewCount = products.reduce((total, product) => total + product.reviews.items.length, 0);
    styleBanner(
        worksheet,
        `${REPORT_NAME} · Extracted reviews`,
        `${output.title} · ${MARKET_NAMES[market]} (${market}) · ${reviewCount} review${
            reviewCount === 1 ? "" : "s"
        }`,
        18
    );
    worksheet.mergeCells("A3:R3");
    worksheet.getCell("A3").value =
        "Within each product, reviews are sorted by helpful-vote count and then by recency. Sentiment is the AI classification used by the report.";
    worksheet.getCell("A3").font = { italic: true, color: { argb: COLORS.grey }, size: 10 };
    worksheet.getCell("A3").alignment = { vertical: "middle", wrapText: true };
    worksheet.getRow(3).height = 26;

    const header = worksheet.getRow(4);
    header.values = [
        "ASIN",
        "Sentiment",
        "Rating",
        "Helpful votes",
        "Review date",
        "Verified purchase",
        "Source language",
        "Review title (original)",
        "Review body (original)",
        "Review title (English)",
        "Review body (English)",
        "Variant (original)",
        "Variant (English)",
        "Review ID",
        "Reviewed ASIN",
        "Collection reason",
        "Date text (original)",
        "Date text (English)"
    ];
    styleTableHeader(header, 18);

    sortedReviewEntries(products).forEach((entry, rowIndex) => {
        const { product, review, reviewIndex } = entry;
        const reviewKey = createReviewKey(review, reviewIndex);
        const sentiment = product.reviewSentiment?.classifications.find(
            classification => classification.reviewKey === reviewKey
        )?.sentiment;
        const translation = product.englishTranslations?.reviews.find(
            candidate => candidate.reviewKey === reviewKey
        );
        const row = worksheet.addRow([
            product.asin,
            sentiment ? `${sentiment[0].toUpperCase()}${sentiment.slice(1)}` : "",
            review.rating,
            review.helpfulCount,
            review.date ?? "",
            review.verifiedPurchase ? "Yes" : "No",
            review.sourceLanguage ?? "",
            safeCellText(stripAmazonRatingFromReviewTitle(review.title)),
            safeCellText(review.comment),
            safeCellText(stripAmazonRatingFromReviewTitle(translation?.title ?? null)),
            safeCellText(translation?.comment),
            safeCellText(review.variant),
            safeCellText(translation?.variant),
            review.id ?? "",
            review.reviewedAsin ?? "",
            formatSelectionReason(review.selectionReason),
            safeCellText(review.dateText),
            safeCellText(translation?.dateText)
        ]);
        row.height = 82;
        styleDataRow(row, 18, rowIndex % 2 === 0 ? COLORS.white : COLORS.greyPale);
        const sentimentFill =
            sentiment === "positive"
                ? COLORS.greenPale
                : sentiment === "negative"
                ? COLORS.redPale
                : COLORS.greyPale;
        const sentimentColor =
            sentiment === "positive"
                ? COLORS.green
                : sentiment === "negative"
                ? COLORS.red
                : COLORS.grey;
        row.getCell(2).fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: sentimentFill }
        };
        row.getCell(2).font = {
            bold: true,
            color: { argb: sentimentColor },
            size: 10
        };
        [3, 4].forEach(column => {
            row.getCell(column).numFmt = "#,##0";
            row.getCell(column).alignment = { horizontal: "center", vertical: "middle" };
        });
        [10, 11, 13, 18].forEach(column => {
            row.getCell(column).fill = {
                type: "pattern",
                pattern: "solid",
                fgColor: { argb: COLORS.bluePale }
            };
        });
    });

    worksheet.autoFilter = { from: "A4", to: `R${Math.max(4, worksheet.rowCount)}` };
    worksheet.pageSetup = {
        orientation: "landscape",
        fitToPage: true,
        fitToWidth: 1,
        fitToHeight: 0,
        paperSize: 9,
        margins: { left: 0.25, right: 0.25, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 }
    };
    worksheet.headerFooter.oddFooter = `&L${REPORT_NAME}&CExtracted reviews&RPage &P of &N`;
}

function createProductSheetNames(products: StoredProduct[]): Map<string, string> {
    const names = new Map<string, string>();
    const used = new Set(["Overview", "Reviews"]);

    for (const product of products) {
        let candidate = product.asin;
        let suffix = 2;

        while (used.has(candidate)) {
            candidate = `${product.asin.slice(0, 26)}-${suffix}`;
            suffix += 1;
        }

        used.add(candidate);
        names.set(product.asin, candidate);
    }

    return names;
}

async function createMarketWorkbook(
    output: StoredOutput,
    market: Market,
    products: StoredProduct[]
): Promise<ExcelJS.Workbook> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = `Numberly · ${REPORT_NAME}`;
    workbook.lastModifiedBy = REPORT_NAME;
    workbook.created = new Date();
    workbook.modified = new Date();
    workbook.company = "Numberly";
    workbook.title = `${output.title} · ${MARKET_NAMES[market]} recommendations`;
    workbook.subject = "Amazon listing recommendations and review evidence";
    workbook.description =
        "Product images, original Amazon listing copy, recommendations, English translations, recommendation rationales, sentiment summaries, and extracted reviews.";
    workbook.keywords = "Amazon, ecommerce, recommendations, reviews, Numberly";
    workbook.calcProperties.fullCalcOnLoad = true;

    const productSheetNames = createProductSheetNames(products);
    const productImages = await registerProductImages(workbook, market, products);
    addOverviewSheet(workbook, output, market, products, productSheetNames, productImages);
    products.forEach(product => {
        addProductSheet(
            workbook,
            output,
            market,
            product,
            productSheetNames.get(product.asin) ?? product.asin,
            productImages.get(product.asin)
        );
    });
    addReviewsSheet(workbook, output, market, products);
    applyWorkbookFont(workbook);

    return workbook;
}

function escapeRegularExpression(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function removeStaleMarketWorkbooks(
    outputDirectory: string,
    datasetBasename: string,
    expectedFilenames: Set<string>
): Promise<void> {
    const pattern = new RegExp(`^${escapeRegularExpression(datasetBasename)}_[a-z]{2}\\.xlsx$`);
    const filenames = await readdir(outputDirectory);
    const staleFilenames = filenames.filter(
        filename => pattern.test(filename) && !expectedFilenames.has(filename)
    );

    await Promise.all(
        staleFilenames.map(filename => rm(path.join(outputDirectory, filename), { force: true }))
    );
}

export async function generateMarketExcelWorkbooks(
    output: StoredOutput,
    outputDirectory: string,
    datasetBasename: string
): Promise<string[]> {
    await Promise.all([
        mkdir(outputDirectory, { recursive: true }),
        mkdir(EXCEL_CACHE_DIRECTORY, { recursive: true })
    ]);

    const expectedFilenames = new Set(
        output.markets.map(({ market }) => `${datasetBasename}_${market}.xlsx`)
    );
    const outputPaths: string[] = [];

    for (const { market, products } of output.markets) {
        const filename = `${datasetBasename}_${market}.xlsx`;
        const outputPath = path.join(outputDirectory, filename);
        const temporaryPath = path.join(
            EXCEL_CACHE_DIRECTORY,
            `${datasetBasename}_${market}.${process.pid}.${Date.now()}.xlsx`
        );
        const workbook = await createMarketWorkbook(output, market, products);

        try {
            await workbook.xlsx.writeFile(temporaryPath);
            await rename(temporaryPath, outputPath);
        } catch (error) {
            await rm(temporaryPath, { force: true });
            throw error;
        }

        outputPaths.push(outputPath);
    }

    await removeStaleMarketWorkbooks(outputDirectory, datasetBasename, expectedFilenames);
    return outputPaths;
}
