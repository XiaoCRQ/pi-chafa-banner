import { describe, expect, test } from "bun:test";
import {
	centerBlock,
	clampLines,
	compactSplash,
	distributeLines,
	infoBox,
	panel,
	plainPainter,
	resourcePanel,
	resourceSection,
	stackNames,
	themePainter,
	THIN_BOX,
	twoColumn,
	wrapNames,
	type Painter,
} from "../src/layout.ts";
import { maxVisibleWidth, stripAnsi, visibleWidth } from "../src/text.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";

/** Every line of a box must occupy exactly the requested width. */
function widths(lines: readonly string[]): number[] {
	return lines.map((line) => visibleWidth(line));
}

const stubTheme: Theme = {
	fg: (_token, text) => `\x1b[36m${text}\x1b[39m`,
	bg: (_token, text) => text,
	bold: (text) => `\x1b[1m${text}\x1b[22m`,
	italic: (text) => text,
	underline: (text) => text,
	getColorMode: () => "truecolor",
};

const painters: Array<[string, Painter]> = [
	["plain", plainPainter],
	["ansi-theme", themePainter(stubTheme)],
];

describe("panel", () => {
	for (const [name, painter] of painters) {
		test(`${name}: box lines are exactly the requested width`, () => {
			const lines = panel("RESOURCES", ["[Skills]", "  btw, workflow-patterns"], 34, painter);
			expect(widths(lines).every((width) => width === 34)).toBe(true);
			expect(lines.length).toBe(4); // top + 2 body + bottom
			expect(stripAnsi(lines[0]!).startsWith("╭")).toBe(true);
			expect(stripAnsi(lines[3]!).startsWith("╰")).toBe(true);
		});

		test(`${name}: title is centered in the top border`, () => {
			const lines = panel("RESOURCES", [], 40, painter);
			const top = stripAnsi(lines[0]!);
			const at = top.indexOf(" RESOURCES ");
			expect(at).toBeGreaterThan(0);
			const leftDashes = at - 1;
			const rightDashes = top.length - (at + " RESOURCES ".length) - 1;
			expect(Math.abs(leftDashes - rightDashes)).toBeLessThanOrEqual(1);
		});

		test(`${name}: fillTo pads the box to a fixed height`, () => {
			const lines = panel("IMAGE", ["x"], 20, painter, { fillTo: 8 });
			expect(lines.length).toBe(8);
			expect(widths(lines).every((width) => width === 20)).toBe(true);
		});

		test(`${name}: long body lines are truncated, not wrapped`, () => {
			const lines = panel(undefined, ["a".repeat(200)], 24, painter);
			expect(widths(lines).every((width) => width === 24)).toBe(true);
			expect(lines.length).toBe(3);
		});
	}

	test("accepts a custom box style", () => {
		const ascii = { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|" };
		const lines = panel(undefined, ["body"], 12, plainPainter, { style: ascii });
		expect(lines[0]).toBe("+" + "-".repeat(10) + "+");
		expect(lines[1]).toBe("| body     |");
		expect(lines[2]).toBe("+" + "-".repeat(10) + "+");
	});

	test("THIN_BOX uses rounded corners", () => {
		expect(THIN_BOX.tl).toBe("╭");
		expect(THIN_BOX.br).toBe("╯");
	});
});

describe("infoBox", () => {
	test("draws one `[Label] value` line per fact", () => {
		const lines = infoBox(
			"CODING AGENT",
			[
				{ label: "Version", value: "1.5.2" },
				{ label: "Model", value: "Claude Sonnet 4.5", suffix: "· high" },
			],
			40,
			plainPainter,
		);
		expect(lines.length).toBe(4);
		// Bracketed labels reuse the `[Context]` heading style of RESOURCES, so
		// every fact fits on a single line with no column padding.
		expect(lines[1]!.startsWith("│ [Version] 1.5.2")).toBe(true);
		expect(lines[2]!.startsWith("│ [Model] Claude Sonnet 4.5 · high")).toBe(true);
		expect(widths(lines).every((width) => width === 40)).toBe(true);
	});

	test("truncates long values to fit", () => {
		const lines = infoBox("T", [{ label: "Model", value: "x".repeat(200) }], 24, plainPainter);
		expect(widths(lines).every((width) => width === 24)).toBe(true);
	});

	test("keeps a suffix on the card when the value has to truncate", () => {
		const lines = infoBox("T", [{ label: "Model", value: "x".repeat(200), suffix: "· high" }], 30, plainPainter);
		expect(widths(lines).every((width) => width === 30)).toBe(true);
		expect(lines[1]!.includes("· high")).toBe(true);
		expect(lines[1]!.includes("...")).toBe(true);
	});

	test("keeps the value readable when the label eats the width", () => {
		const lines = infoBox("T", [{ label: "Thinking", value: "medium" }], 14, plainPainter);
		expect(widths(lines).every((width) => width === 14)).toBe(true);
	});
});

describe("wrapNames", () => {
	test("wraps greedily with a two-space indent", () => {
		const lines = wrapNames(["alpha", "beta", "gamma", "delta"], 20);
		expect(lines.length).toBeGreaterThan(1);
		expect(lines[0]!.startsWith("  ")).toBe(true);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(20);
	});

	test("collapses overflow to ', ...'", () => {
		const names = Array.from({ length: 20 }, (_, index) => `skill-${index}`);
		const lines = wrapNames(names, 24, 2);
		expect(lines.length).toBe(2);
		expect(lines[lines.length - 1]!.endsWith(", ...")).toBe(true);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(24);
	});

	test("empty list yields a blank indented line", () => {
		expect(wrapNames([], 20)).toEqual(["  "]);
	});
});

describe("stackNames", () => {
	test("puts one name per line with a two-space indent", () => {
		expect(stackNames(["a", "b"], 20)).toEqual(["  a", "  b"]);
	});

	test("collapses the tail to ... when the rows run out", () => {
		const names = Array.from({ length: 10 }, (_, index) => `ext-${index}`);
		expect(stackNames(names, 24, 4)).toEqual(["  ext-0", "  ext-1", "  ext-2", "  ..."]);
	});

	test("a single row keeps the first name plus `, ...`", () => {
		const lines = stackNames(["@scope/pkg:dist", "other"], 24, 1);
		expect(lines.length).toBe(1);
		expect(lines[0]!.startsWith("  @scope/pkg")).toBe(true);
		expect(lines[0]!.endsWith(", ...")).toBe(true);
		expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(24);
	});

	test("truncates a single long name to the width", () => {
		const lines = stackNames(["x".repeat(60)], 20);
		expect(lines.length).toBe(1);
		expect(lines[0]!.includes("...")).toBe(true);
		expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(20);
	});
});

describe("distributeLines", () => {
	test("gives every list one line first", () => {
		expect(distributeLines([1, 1, 1], 10)).toEqual([1, 1, 1]);
		expect(distributeLines([4, 4], 4)).toEqual([2, 2]);
	});

	test("never drops a list even when the budget is tight", () => {
		const caps = distributeLines([9, 9, 9], 2);
		expect(caps.every((cap) => cap >= 1)).toBe(true);
	});

	test("spare rows go to the most truncated list", () => {
		const caps = distributeLines([10, 1], 5);
		expect(caps[0]!).toBeGreaterThan(caps[1]!);
	});
});

describe("resourceSection / resourcePanel", () => {
	test("renders an empty section placeholder", () => {
		const lines = resourceSection("Skills", [], 20, plainPainter);
		expect(lines).toEqual(["[Skills]", "  (none)"]);
	});

	test("stacked sections draw one extension per row", () => {
		const lines = resourceSection("Extensions", ["pi-btw:btw.ts", "pi-chafa-banner"], 30, plainPainter, Infinity, true);
		expect(lines).toEqual(["[Extensions]", "  pi-btw:btw.ts", "  pi-chafa-banner"]);
	});

	test("a stacked section budgeted to two rows ends with ...", () => {
		const lines = resourceSection("Extensions", ["a:1", "b:2", "c:3"], 30, plainPainter, 2, true);
		expect(lines).toEqual(["[Extensions]", "  a:1", "  ..."]);
	});

	test("panel lines never exceed the width and the box is exact", () => {
		const sections = [
			{ title: "Context", names: ["AGENTS.md", "~/.pi/agent/AGENTS.md"] },
			{ title: "Skills", names: ["btw"] },
			{ title: "Themes", names: [] },
			{ title: "Extensions", names: ["pi-btw", "pi-chafa-banner"] },
		];
		const lines = resourcePanel("RESOURCES", sections, 44, plainPainter);
		expect(widths(lines).every((width) => width === 44)).toBe(true);
		expect(lines[0]!.includes("RESOURCES")).toBe(true);
	});

	test("totalRows fixes the height and budgets the sections", () => {
		const sections = Array.from({ length: 4 }, (_, index) => ({
			title: `S${index}`,
			names: Array.from({ length: 12 }, (_, n) => `name-${index}-${n}`),
		}));
		const lines = resourcePanel("RESOURCES", sections, 40, plainPainter, 18);
		expect(lines.length).toBe(18);
		expect(widths(lines).every((width) => width === 40)).toBe(true);
	});

	test("drops sections that cannot fit at all", () => {
		const sections = [
			{ title: "A", names: ["1"] },
			{ title: "B", names: ["2"] },
			{ title: "C", names: ["3"] },
		];
		const lines = resourcePanel("R", sections, 30, plainPainter, 6);
		expect(lines.length).toBe(6);
		expect(lines.join("\n")).toContain("[A]");
		expect(lines.join("\n")).not.toContain("[C]");
	});
});

describe("twoColumn / centering", () => {
	test("pads the right block to the left block width", () => {
		const left = ["aaa", "bbbb"];
		const right = ["x", "yy", "zzz"];
		const lines = twoColumn(left, right, 4, 20);
		expect(lines.length).toBe(3);
		expect(lines[2]!.startsWith("    " + " ".repeat(4))).toBe(true);
		expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(20);
	});

	test("never exceeds the total width", () => {
		const lines = twoColumn(["abcdefgh"], ["ijklmnop"], 4, 10);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(10);
	});

	test("centerBlock pads the left side only", () => {
		const lines = centerBlock(["ab", "abcd"], 10);
		expect(lines).toEqual(["   ab", "   abcd"]);
	});

	test("centerBlock clamps instead of padding when too wide", () => {
		const lines = centerBlock(["abcdef"], 4);
		expect(maxVisibleWidth(lines)).toBeLessThanOrEqual(4);
	});

	test("clampLines clips every line", () => {
		expect(clampLines(["abcdef", "ab"], 3)).toEqual(["abc", "ab"]);
	});
});

describe("compactSplash", () => {
	test("returns three narrow lines", () => {
		const lines = compactSplash(28, plainPainter, { version: "1.5.2", model: "claude", thinking: "high" });
		expect(lines.length).toBe(3);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(28);
		expect(lines[0]).toContain("1.5.2");
	});
});
