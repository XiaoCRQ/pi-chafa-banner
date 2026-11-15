import { describe, expect, test } from "bun:test";
import { centerVisible, padVisible, sliceVisible, stripAnsi, truncateToWidth, visibleWidth } from "../src/text.ts";

const RED = "\x1b[31m";
const RESET = "\x1b[39m";

describe("visibleWidth", () => {
	test("ignores SGR sequences", () => {
		expect(visibleWidth(`${RED}abc${RESET}`)).toBe(3);
		expect(visibleWidth("\x1b[38;2;10;20;30m▀▄█\x1b[39m")).toBe(3);
	});

	test("counts half-blocks and box drawing as one column", () => {
		expect(visibleWidth("▀▄█╭─╮│")).toBe(7);
	});

	test("counts CJK and emoji as two columns", () => {
		expect(visibleWidth("中文")).toBe(4);
		expect(visibleWidth("🙂")).toBe(2);
	});

	test("counts BMP emoji/symbols and emoji sequences like pi-tui", () => {
		// These are 2 columns in pi-tui but were previously underestimated as 1.
		for (const emoji of ["⌚", "⭐", "✅", "⚡", "⌛", "✊", "🀄", "🈚", "⚽"]) {
			expect(visibleWidth(emoji)).toBe(2);
		}
		// Whole grapheme clusters count as one 2-column emoji, not per code point.
		expect(visibleWidth("👍🏽")).toBe(2);
		expect(visibleWidth("👨‍👩‍👧")).toBe(2);
		expect(visibleWidth("1️⃣")).toBe(2);
		expect(visibleWidth("🇨🇳")).toBe(2);
		// ...while non-emoji symbols in the same blocks stay 1 column.
		expect(visibleWidth("★")).toBe(1);
		expect(visibleWidth("✔")).toBe(1);
	});

	test("ignores zero-width joiners and combining marks", () => {
		expect(visibleWidth("e\u0301")).toBe(1);
	});

	test("ignores OSC-8 hyperlinks", () => {
		expect(visibleWidth("\x1b]8;;https://example.com\x07link\x1b]8;;\x07")).toBe(4);
	});
});

describe("stripAnsi", () => {
	test("removes SGR but keeps text", () => {
		expect(stripAnsi(`${RED}hi${RESET}`)).toBe("hi");
	});
});

describe("padVisible / centerVisible / sliceVisible", () => {
	test("pads to exact width ignoring escapes", () => {
		const padded = padVisible(`${RED}ab${RESET}`, 5);
		expect(visibleWidth(padded)).toBe(5);
		expect(padded.startsWith(`${RED}ab${RESET}`)).toBe(true);
	});

	test("never shrinks a wider string", () => {
		expect(padVisible("abcdef", 3)).toBe("abcdef");
	});

	test("centers with the odd column on the right", () => {
		expect(centerVisible("ab", 5)).toBe(" ab  ");
	});

	test("slices by visible columns", () => {
		expect(sliceVisible("abcdef", 1, 2)).toBe("bc");
		expect(sliceVisible("abcdef", 4, 2)).toBe("ef");
		expect(sliceVisible("abcdef", 4, 0)).toBe("");
	});
});

describe("truncateToWidth", () => {
	test("leaves short strings alone", () => {
		expect(truncateToWidth("abc", 10)).toBe("abc");
	});

	test("adds an ellipsis by default", () => {
		expect(stripAnsi(truncateToWidth("abcdefgh", 5))).toBe("ab...");
	});

	test("pads when asked", () => {
		expect(visibleWidth(truncateToWidth("ab", 6, "…", true))).toBe(6);
	});

	test("handles wide characters without splitting", () => {
		const out = truncateToWidth("中文中文", 5, "…");
		expect(visibleWidth(out)).toBeLessThanOrEqual(5);
		expect(stripAnsi(out)).toBe("中文…") // 4 + 1
	});

	test("clips the ellipsis into a budget it does not fit into", () => {
		// pi-tui's `truncateFragmentToWidth`: a 1-column line still ends with `…`
		// rather than going blank when the first grapheme is wider than the budget.
		expect(stripAnsi(truncateToWidth("中文", 1, "…"))).toBe("…");
		expect(stripAnsi(truncateToWidth("abcdef", 1, "..."))).toBe(".");
		expect(stripAnsi(truncateToWidth("abcdef", 2, "..."))).toBe("..");
		// Nothing fits at all -> still no overflow.
		expect(truncateToWidth("中文", 0, "…")).toBe("");
	});

	test("never splits emoji grapheme clusters", () => {
		expect(stripAnsi(truncateToWidth("👨‍👩‍👧x", 2, ""))).toBe("👨‍👩‍👧");
		expect(visibleWidth(truncateToWidth("⌚⌚⌚", 5, "…"))).toBeLessThanOrEqual(5);
	});

	test("always terminates on a lone/unrecognized escape", () => {
		const out = truncateToWidth("\x1b(abcdef", 3, "");
		expect(visibleWidth(out)).toBeLessThanOrEqual(3);
		expect(sliceVisible("\x1b(abcdef", 0, 3).length).toBeGreaterThan(0);
	});

	test("counts trailing escapes even when the text is cut", () => {
		const out = truncateToWidth(`${RED}abcdef${RESET}`, 4, "");
		expect(visibleWidth(out)).toBe(4);
	});
});
