/**
 * Integration tests for the composed splash (Banner + layout), not just the
 * individual box helpers. These are the invariants pi's renderer depends on:
 *
 *   - no returned line is wider than the width passed to render()
 *   - the block is horizontally centered (left/right slack differ by <= 1 col)
 *   - narrow terminals switch from two columns to the stacked layout
 *   - box titles are centered in the top border
 *
 * No pi process, no chafa: the frame set is synthesized and the theme is a stub.
 */

import { describe, expect, test } from "bun:test";
import { Banner } from "../src/banner.ts";
import { DEFAULTS, type BannerConfig } from "../src/config.ts";
import type { FrameSet } from "../src/frames.ts";
import { panel, plainPainter } from "../src/layout.ts";
import { emptyResources, type BannerResources } from "../src/resources.ts";
import { stripAnsi, visibleWidth } from "../src/text.ts";
import type { Theme, TUI } from "@earendil-works/pi-coding-agent";

const stubTheme: Theme = {
	fg: (_token, text) => text,
	bg: (_token, text) => text,
	bold: (text) => text,
	italic: (text) => text,
	underline: (text) => text,
	getColorMode: () => "truecolor",
};

const stubTui = {
	mode: "inline",
	terminal: { rows: 40, columns: 100 },
	requestRender: () => {},
} as unknown as TUI;

const ART_WIDTH = 44;
const ART_HEIGHT = 22;

function frames(count = 3): FrameSet {
	const frames = Array.from({ length: count }, (_, index) =>
		Array.from({ length: ART_HEIGHT }, () => {
			const tag = String(index % 10);
			return `▀▄█`.repeat(Math.ceil(ART_WIDTH / 3)).slice(0, ART_WIDTH - 1) + tag;
		}),
	);
	return {
		frames,
		width: ART_WIDTH,
		height: ART_HEIGHT,
		colorMode: "truecolor",
		gifPath: "/tmp/preview.gif",
		totalFrames: count,
		stride: 1,
		delays: Array.from({ length: count }, () => 100),
		fromCache: true,
		builtAt: Date.now(),
	};
}

function resources(): BannerResources {
	return {
		...emptyResources(),
		version: "1.5.2",
		model: "anthropic/claude-sonnet-4-5",
		theme: "dark",
		context: ["AGENTS.md", "~/.pi/agent/AGENTS.md"],
		skills: ["btw", "workflow-authoring", "workflow-patterns"],
		themes: ["dark", "light"],
		extensions: ["pi-btw", "pi-dynamic-workflows", "pi-chafa-banner"],
	};
}

const config: BannerConfig = {
	...DEFAULTS,
	gifPath: "/tmp/preview.gif",
	enabled: true,
	static: true,
};

function makeBanner(): Banner {
	return new Banner(stubTui, stubTheme, { config, resources: resources(), frames: frames() });
}

/**
 * Leading spaces, ignoring ANSI and the deliberate blank rows (the separator
 * between the art band and the panels, or the art's reserved rows).
 */
function leadingSpaces(line: string): number {
	const plain = stripAnsi(line);
	if (plain.trim() === "") return Number.POSITIVE_INFINITY;
	return plain.length - plain.trimStart().length;
}

/** Visible width, or -1 for a blank row (see `leadingSpaces`). */
function trailingSpan(line: string): number {
	const plain = stripAnsi(line);
	return plain.trim() === "" ? -1 : visibleWidth(line);
}

const WIDTHS = [40, 60, 80, 100, 140] as const;

describe("composed splash width contract", () => {
	for (const width of WIDTHS) {
		test(`every line fits in ${width} columns`, () => {
			const banner = makeBanner();
			const lines = banner.render(width);
			expect(lines.length).toBeGreaterThan(0);
			for (const line of lines) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				expect(line.includes("\n")).toBe(false);
			}
			banner.dispose();
		});

		test(`block is horizontally centered within 1 column at ${width}`, () => {
			const banner = makeBanner();
			const lines = banner.render(width);
			// The left column starts at the block's left edge and the right column ends
			// at its right edge, so the block's bounding box is what must be centered.
			const left = Math.min(...lines.map(leadingSpaces));
			const right = width - Math.max(...lines.map(trailingSpan));
			expect(Math.abs(left - right)).toBeLessThanOrEqual(1);
			banner.dispose();
		});
	}
});

describe("responsive layout", () => {
	test("narrow width (60) stacks the resources panel below the info card", () => {
		const banner = makeBanner();
		const lines = banner.render(60).map(stripAnsi);
		const infoIndex = lines.findIndex((line) => line.includes("(pi) CODING AGENT"));
		const resourcesIndex = lines.findIndex((line) => line.includes("RESOURCES"));
		expect(infoIndex).toBeGreaterThan(0);
		expect(resourcesIndex).toBeGreaterThan(infoIndex);
		// The panel is a standalone full-width box, not a side column.
		expect(lines[resourcesIndex]).toContain("╭");
		banner.dispose();
	});

	test("wide width (100) stacks the art band above two equal panels", () => {
		const banner = makeBanner();
		const lines = banner.render(100).map(stripAnsi);
		// Both renderers share one shape: the art owns the whole band, the panels
		// sit below it and are separated by a vertical divider in the mid column.
		expect(lines[0]).not.toContain("RESOURCES");
		const resourcesIndex = lines.findIndex((line) => line.includes("RESOURCES"));
		const infoIndex = lines.findIndex((line) => line.includes("(pi) CODING AGENT"));
		expect(infoIndex).toBeGreaterThan(0);
		expect(resourcesIndex).toBe(infoIndex);

		const top = lines[infoIndex] as string;
		const start = top.indexOf("╭");
		const gap = top.indexOf("╮", start) + 1;
		const left = top.slice(start, gap);
		const right = top.slice(top.indexOf("╭", gap));
		expect(visibleWidth(left)).toBe(visibleWidth(right));
		expect(top.slice(gap, top.indexOf("╭", gap)).trim()).toBe("");
		banner.dispose();
	});

	test("below 32 columns falls back to the three-line compact splash", () => {
		const banner = makeBanner();
		const lines = banner.render(24);
		expect(lines.length).toBe(3);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(24);
		banner.dispose();
	});
});

describe("box titles", () => {
	for (const width of [28, 29, 40, 41, 60]) {
		test(`RESOURCES title is centered at width ${width}`, () => {
			const top = stripAnsi(panel("RESOURCES", [], width, plainPainter)[0]!).replace(/^\x1b\[[0-9;]*m/, "");
			const at = top.indexOf(" RESOURCES ");
			expect(at).toBeGreaterThan(0);
			const leftDashes = at - 1;
			const rightDashes = top.length - (at + " RESOURCES ".length) - 1;
			expect(Math.abs(leftDashes - rightDashes)).toBeLessThanOrEqual(1);
		});
	}

	test("the info card title is centered too", () => {
		const banner = makeBanner();
		const top = banner.render(100).map(stripAnsi).find((line) => line.includes("(pi) CODING AGENT"));
		expect(top).toBeDefined();
		const at = top!.indexOf(" (pi) CODING AGENT ");
		const leftDashes = at - top!.indexOf("╭") - 1;
		// The info card shares its row with the RESOURCES box, so stop at its own
		// top-right corner rather than the last one on the line.
		const rightDashes = top!.indexOf("╮", at) - (at + " (pi) CODING AGENT ".length);
		expect(Math.abs(leftDashes - rightDashes)).toBeLessThanOrEqual(1);
		banner.dispose();
	});
});
