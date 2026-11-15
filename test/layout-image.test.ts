import { describe, expect, test } from "bun:test";
import {
	CHROME_ROWS,
	IMAGE_GAP_ROWS,
	blockWidthFor,
	clampLines,
	imageBandBudget,
	imageReservedRows,
	MIN_IMAGE_COLUMNS,
	parseKittyRows,
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

	test("the picture height never depends on the terminal", () => {
		// Whatever the window, the pipeline is asked for the configured picture
		// size: a short terminal must not shrink the picture, the panel block below
		// gives way instead (render() simply overflows and pi scrolls).
		for (const cols of [40, 60, 100, 160]) {
			expect(imageBandBudget({ cols, size: { width: 44, height: 22 } }).maxRows).toBe(22);
		}
	});

	test("splashRows subtracts pi's chrome and never goes below ten", () => {
		expect(CHROME_ROWS).toBe(7);
		expect(splashRows(40)).toBe(33);
		expect(splashRows(100)).toBe(93);
		expect(splashRows(12)).toBe(10);
	});
});
