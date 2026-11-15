import { describe, expect, test } from "bun:test";
import {
	CHROME_ROWS,
	IMAGE_GAP_ROWS,
	MIN_LOWER_ROWS,
	blockWidthFor,
	clampLines,
	imageBandBudget,
	imageReservedRows,
	MIN_IMAGE_COLUMNS,
	MIN_IMAGE_ROWS,
	parseKittyRows,
	planImageBand,
	splashRows,
	twoColumn,
} from "../src/layout.ts";
import { visibleWidth } from "../src/text.ts";

/** Root frame with r=22, followed by animation opcodes, like `buildKittyLine`. */
const SEQ =
	`\x1b_Ga=T,f=100,q=2,C=1,c=44,r=22,i=7;${"A".repeat(64)}\x1b\\` +
	`\x1b_Ga=a,i=7,r=1,z=63\x1b\\` +
	`\x1b_Ga=a,i=7,s=3,v=1,q=2\x1b\\`;

describe("layout: image lines pass through", () => {
	test("clampLines keeps image lines and empty strings intact", () => {
		const lines = [SEQ, "", "", "plain text that is too wide for forty columns"];
		const out = clampLines(lines, 40);
		expect(out[0]).toBe(SEQ);
		expect(out[1]).toBe("");
		expect(out[2]).toBe("");
		expect(visibleWidth(out[3] ?? "")).toBeLessThanOrEqual(40);
	});

	test("twoColumn does not pad the image side", () => {
		const out = twoColumn([SEQ, ""], ["right", "right2"], 4, 40);
		expect(out[0]).toBe(SEQ);
		// The empty left cell still aligns the right column at the separator.
		expect(out[1]).toBe(`    right2`);
	});
});

describe("layout: kitty row accounting", () => {
	test("parseKittyRows reads r= from the root frame only", () => {
		expect(parseKittyRows(SEQ)).toBe(22);
		expect(parseKittyRows("plain")).toBe(1);
		expect(parseKittyRows("\x1b_Ga=T,i=1;AAAA\x1b\\")).toBe(1);
	});

	test("imageReservedRows counts strictly empty continuations", () => {
		expect(imageReservedRows([SEQ, "", "", "x"], 0)).toBe(3);
		expect(imageReservedRows([SEQ, "  ", ""], 0)).toBe(1);
		expect(imageReservedRows([SEQ, "text"], 0)).toBe(1);
		expect(imageReservedRows(["no image"], 0)).toBe(1);
	});
});

describe("layout: image band budget", () => {
	test("wide terminal is capped by PI_BANNER_SIZE", () => {
		expect(blockWidthFor(100)).toBe(96);
		expect(imageBandBudget({ cols: 100, size: { width: 44, height: 22 } })).toEqual({
			maxColumns: 44,
			maxRows: 22,
		});
	});

	test("the build keeps the requested canvas even on a short terminal", () => {
		// Cropping happens at render time (`planImageBand`), so the pipeline must not
		// shrink the picture: a 4-row budget would hand back 8 columns instead of 44.
		expect(imageBandBudget({ cols: 100, size: { width: 44, height: 22 } })).toEqual({
			maxColumns: 44,
			maxRows: 22,
		});
	});

	test("narrow terminals shrink the columns only", () => {
		expect(imageBandBudget({ cols: 40, size: { width: 44, height: 22 } })).toEqual({
			maxColumns: 36,
			maxRows: 22,
		});
	});

	test("the worst-case render still fits the document body pi gives us", () => {
		// The band is cropped to `planImageBand().rows`, so what has to fit is
		// band + gap + minimum lower block. Below ~24 rows even that does not fit and
		// render() clamps the lower block instead (covered by banner-image.test.ts).
		for (const rows of [20, 24, 30, 40, 45, 60, 100]) {
			for (const statusRows of [0, 1]) {
				const budget = imageBandBudget({ cols: 100, size: { width: 44, height: 22 } });
				const body = splashRows(rows);
				const plan = planImageBand({
					totalRows: body,
					statusRows,
					availableColumns: 96,
					image: { rows: budget.maxRows, columns: budget.maxColumns, pixelWidth: 396, pixelHeight: 396 },
				});
				if (!plan) continue;
				expect(plan.rows + IMAGE_GAP_ROWS + statusRows).toBeLessThanOrEqual(body);
				const needed = plan.rows + IMAGE_GAP_ROWS + MIN_LOWER_ROWS + statusRows;
				if (body >= MIN_LOWER_ROWS + IMAGE_GAP_ROWS + MIN_IMAGE_ROWS) expect(needed).toBeLessThanOrEqual(body);
				expect(plan.rows + IMAGE_GAP_ROWS + statusRows + CHROME_ROWS).toBeLessThanOrEqual(rows);
			}
		}
	});

	test("splashRows subtracts pi's chrome and never goes below ten", () => {
		expect(CHROME_ROWS).toBe(7);
		expect(splashRows(40)).toBe(33);
		expect(splashRows(100)).toBe(93);
		expect(splashRows(12)).toBe(10);
	});
});

describe("planImageBand", () => {
	const picture = { rows: 22, columns: 44, pixelWidth: 396, pixelHeight: 396 };

	test("a picture that fits is used verbatim", () => {
		// 22 image rows + 1 gap + 11 lower rows needs a 34-row body.
		const plan = planImageBand({ totalRows: 34, statusRows: 0, availableColumns: 96, image: picture });
		expect(plan).toBeDefined();
		expect(plan!.whole).toBe(true);
		expect(plan!.rows).toBe(22);
		expect(plan!.columns).toBe(44);
		expect(plan!.hiddenRows).toBe(0);
		expect(plan!.sourceY).toBe(0);
		expect(plan!.sourceHeight).toBe(396);
	});

	test("a short body keeps room for the lower block and crops the top", () => {
		const plan = planImageBand({ totalRows: 23, statusRows: 0, availableColumns: 96, image: picture });
		expect(plan).toBeDefined();
		expect(plan!.rows).toBe(23 - IMAGE_GAP_ROWS - MIN_LOWER_ROWS);
		expect(plan!.rows + IMAGE_GAP_ROWS + MIN_LOWER_ROWS).toBeLessThanOrEqual(23);
		expect(plan!.whole).toBe(false);
		// Cropped from the top third, so the subject stays visible.
		expect(plan!.hiddenRows).toBeGreaterThan(0);
		expect(plan!.sourceY).toBeGreaterThan(0);
		expect(plan!.sourceHeight).toBeLessThan(396);
		expect(plan!.sourceY + plan!.sourceHeight).toBeLessThanOrEqual(396);
	});

	test("a very short body still shows MIN_IMAGE_ROWS rows", () => {
		const plan = planImageBand({ totalRows: 12, statusRows: 1, availableColumns: 96, image: picture });
		expect(plan).toBeDefined();
		expect(plan!.rows).toBe(MIN_IMAGE_ROWS);
		expect(plan!.hiddenRows).toBeGreaterThan(0);
	});

	test("a narrow terminal crops columns and skips pixels on both sides", () => {
		const plan = planImageBand({ totalRows: 40, statusRows: 0, availableColumns: 30, image: picture });
		expect(plan).toBeDefined();
		expect(plan!.columns).toBe(30);
		expect(plan!.hiddenColumns).toBe(Math.floor((44 - 30) / 2));
		expect(plan!.sourceX).toBeGreaterThan(0);
		expect(plan!.sourceWidth).toBeLessThan(396);
	});

	test("no room at all declines the band", () => {
		expect(planImageBand({ totalRows: 33, statusRows: 0, availableColumns: MIN_IMAGE_COLUMNS - 1, image: picture })).toBeUndefined();
		expect(planImageBand({ totalRows: 1, statusRows: 1, availableColumns: 96, image: picture })).toBeUndefined();
	});

	test("the crop never exceeds the source picture", () => {
		for (const totalRows of [10, 14, 20, 26, 33, 40, 60]) {
			for (const availableColumns of [8, 20, 44, 96]) {
				const plan = planImageBand({ totalRows, statusRows: 0, availableColumns, image: picture });
				if (!plan) continue;
				expect(plan.rows).toBeGreaterThanOrEqual(1);
				expect(plan.rows).toBeLessThanOrEqual(picture.rows);
				expect(plan.columns).toBeGreaterThanOrEqual(1);
				expect(plan.columns).toBeLessThanOrEqual(picture.columns);
				expect(plan.sourceX).toBeGreaterThanOrEqual(0);
				expect(plan.sourceY).toBeGreaterThanOrEqual(0);
				expect(plan.sourceX + plan.sourceWidth).toBeLessThanOrEqual(picture.pixelWidth);
				expect(plan.sourceY + plan.sourceHeight).toBeLessThanOrEqual(picture.pixelHeight);
			}
		}
	});
});
