import { describe, expect, test } from "bun:test";
import { Banner, cachedImageLineCount, clearImageLineCache, type BannerInit } from "../src/banner.ts";
import { DEFAULTS, type BannerConfig } from "../src/config.ts";
import type { ImageFrameSet } from "../src/images.ts";
import { blockWidthFor, CHROME_ROWS, parseKittyRows } from "../src/layout.ts";
import { emptyResources, type BannerResources } from "../src/resources.ts";
import { isImageLine, visibleWidth } from "../src/text.ts";
import { replaceKittyPayload } from "../src/kitty.ts";
import type { Theme, TUI } from "@earendil-works/pi-coding-agent";

const theme: Theme = {
	fg: (_token, text) => text,
	bg: (_token, text) => text,
	bold: (text) => text,
	italic: (text) => text,
	underline: (text) => text,
	getColorMode: () => "truecolor",
};

function fakeTui(rows = 40, columns = 100): TUI {
	return {
		mode: "regular",
		terminal: { rows, columns },
		requestRender: () => undefined,
	} as unknown as TUI;
}

const baseConfig: BannerConfig = { ...DEFAULTS, gifPath: "/tmp/x.gif", enabled: true, static: false };

function resources(): BannerResources {
	return {
		...emptyResources(),
		version: "1.5.2",
		model: "anthropic/claude-sonnet-4-5",
		theme: "dark",
		context: ["AGENTS.md"],
		skills: ["btw", "workflow-patterns"],
		themes: ["dark", "light"],
		extensions: ["pi-btw", "pi-chafa-banner"],
	};
}

const PAYLOAD = "A".repeat(400);

function imageSet(overrides: Partial<ImageFrameSet> = {}): ImageFrameSet {
	const columns = overrides.columns ?? 44;
	// 44x20 stands in for a picture the pipeline built for an older/other size;
	// short terminals crop whatever the cache holds (layout.ts planImageBand).
	const rows = overrides.rows ?? 20;
	const count = overrides.frames?.length ?? 3;
	return {
		protocol: "kitty",
		frames: Array.from({ length: count }, (_, index) => ({ base64: `${PAYLOAD}${index}` })),
		columns,
		rows,
		pixelWidth: columns * 9,
		pixelHeight: rows * 18,
		imageId: 4242,
		sequence: `\x1b_Ga=T,f=100,q=2,C=1,c=${columns},r=${rows},i=4242;${PAYLOAD}\x1b\\`,
		gapMs: 63,
		gifPath: "/tmp/x.gif",
		totalFrames: 57,
		stride: 3,
		palette: 128,
		fromCache: true,
		builtAt: 1,
		...overrides,
	};
}

function banner(init: Partial<BannerInit> = {}, rows = 40, columns = 100): Banner {
	return new Banner(fakeTui(rows, columns), theme, {
		config: baseConfig,
		resources: resources(),
		renderer: "kitty",
		images: imageSet(),
		...init,
	});
}

function imageLines(lines: readonly string[]): string[] {
	return lines.filter((line) => isImageLine(line));
}

describe("banner: image band structure", () => {
	test("exactly one image line, followed by rows-1 strict empty lines", () => {
		const set = imageSet({ rows: 11, columns: 22 });
		const lines = banner({ images: set }).render(100);
		const indexed = lines.map((line, index) => ({ line, index })).filter(({ line }) => isImageLine(line));
		expect(indexed.length).toBe(1);
		const start = indexed[0]!.index;
		expect(parseKittyRows(indexed[0]!.line)).toBe(11);
		// `getKittyImageReservedRows` counts only lines that are exactly "".
		for (let offset = 1; offset < 11; offset++) {
			expect(lines[start + offset]).toBe("");
		}
		// One blank gap row, then the boxes.
		expect(lines[start + 11]).toBe("");
		expect(visibleWidth(lines[start + 12] ?? "")).toBeGreaterThan(0);
	});

	test("width contract holds on every terminal width", () => {
		for (const width of [20, 31, 40, 60, 76, 90, 108, 140]) {
			const block = blockWidthFor(width);
			const set = imageSet({ columns: Math.max(4, block - 8), rows: 8 });
			const lines = banner({ images: set }, 40, width).render(width);
			for (const line of lines) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});

	test("total height never exceeds the terminal", () => {
		for (const rows of [20, 24, 30, 40, 60]) {
			const lines = banner({ images: imageSet() }, rows).render(100);
			expect(lines.length).toBeLessThanOrEqual(rows);
		}
	});

	test("the splash leaves room for pi's editor/footer/header spacers", () => {
		// Regression for the clipped-top-image bug: the document viewport is
		// `rows - CHROME_ROWS`, not `rows`. A splash taller than that scrolls the
		// image anchor out of view, and pi's main-screen renderer answers with
		// `fullRender(true)` (clear screen + scrollback) on every frame change.
		for (const rows of [24, 30, 40, 50, 80]) {
			const set = imageSet({ rows: 4 });
			const lines = banner({ images: set }, rows).render(100);
			expect(lines.length + CHROME_ROWS).toBeLessThanOrEqual(rows);
		}
	});

	test("a 40-row terminal crops the 44x22 canvas instead of dropping it", () => {
		// A picture taller than the body is cropped via the source rect, never
		// replaced by a card.
		const lines = banner({ images: imageSet({ rows: 22 }) }, 40).render(100);
		expect(imageLines(lines).length).toBe(1);
		const line = imageLines(lines)[0]!;
		// body (33) - gap (1) - the panels' preferred height (12).
		expect(parseKittyRows(line)).toBe(20);
		expect(line).toContain("h=");
		expect(line).toContain("y=0");
		expect(lines.some((text) => text.includes("IMAGE"))).toBe(false);
		expect(lines.length + CHROME_ROWS).toBeLessThanOrEqual(40);
	});

	test("an image that eats the whole document body is cropped, not dropped", () => {
		const lines = banner({ images: imageSet({ rows: 22 }) }, 24).render(100);
		expect(imageLines(lines).length).toBe(1);
		const rows = parseKittyRows(imageLines(lines)[0]!);
		expect(rows).toBeGreaterThanOrEqual(4);
		expect(rows).toBeLessThan(22);
		expect(lines.some((line) => line.includes("IMAGE"))).toBe(false);
		expect(lines.length).toBeLessThanOrEqual(24);
	});

	test("tiny terminals degrade without overflowing", () => {
		for (const rows of [10, 11, 12, 13, 14, 16]) {
			for (const [columns, imageRows] of [[44, 22], [10, 4]]) {
				const lines = banner({ images: imageSet({ columns, rows: imageRows }), status: "boom" }, rows).render(100);
				expect(lines.length).toBeLessThanOrEqual(rows);
				for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(100);
			}
		}
	});

	test("no line has a newline in it", () => {
		const lines = banner().render(100);
		for (const line of lines) expect(line.includes("\n")).toBe(false);
	});

	test("image line is indented by leftPad + imgPad and nothing else", () => {
		const cols = 100;
		const set = imageSet({ columns: 30, rows: 6 });
		const lines = banner({ images: set }).render(cols);
		const line = imageLines(lines)[0]!;
		const blockWidth = blockWidthFor(cols);
		const leftPad = Math.floor((cols - blockWidth) / 2);
		const imgPad = Math.floor((blockWidth - set.columns) / 2);
		expect(line.startsWith(" ".repeat(leftPad + imgPad) + "\x1b_G")).toBe(true);
		// Zero-width: the padding is the whole visible width.
		expect(visibleWidth(line)).toBe(leftPad + imgPad);
	});
});

describe("banner: lower block", () => {
	test("two columns line up and keep all four sections", () => {
		const lines = banner({ images: imageSet() }).render(100);
		const imageIndex = lines.findIndex((line) => isImageLine(line));
		const imageRows = parseKittyRows(lines[imageIndex]!);
		const lower = lines.slice(imageIndex + imageRows + 1);
		expect(lower.length).toBeGreaterThanOrEqual(11);
		// Both boxes are the same height, so every line has a right border.
		const leftEdges = lower.filter((line) => line.trimStart().startsWith("╭") || line.trimStart().startsWith("╰"));
		expect(leftEdges.length).toBe(2);
		// Two boxes side by side: one row opens two frames.
		expect(lower.some((line) => (line.match(/╭/g) ?? []).length === 2)).toBe(true);
		for (const title of ["Context", "Skills", "Themes", "Extensions"]) {
			expect(lower.some((line) => line.includes(`[${title}]`))).toBe(true);
		}
	});

	test("narrow terminals stack info over the panel", () => {
		const lines = banner({ images: imageSet({ columns: 40, rows: 10 }) }, 40, 60).render(60);
		const imageIndex = lines.findIndex((line) => isImageLine(line));
		expect(imageIndex).toBeGreaterThanOrEqual(0);
		const lower = lines.slice(imageIndex + parseKittyRows(lines[imageIndex]!) + 1);
		expect(lower.some((line) => line.includes("(pi) CODING AGENT"))).toBe(true);
		expect(lower.some((line) => line.includes("[Context]"))).toBe(true);
		expect(lower.some((line) => (line.match(/╭/g) ?? []).length === 2)).toBe(false);
		// Stacked boxes share the full block width.
		const tops = lower.filter((line) => line.includes("╭"));
		expect(tops.length).toBe(2);
		expect(new Set(tops.map((line) => visibleWidth(line))).size).toBe(1);
	});
});

describe("banner: degradation", () => {
	test("an oversized image is cropped rather than replaced by the placeholder", () => {
		const lines = banner({ images: imageSet() }, 20).render(100);
		expect(imageLines(lines).length).toBe(1);
		expect(parseKittyRows(imageLines(lines)[0]!)).toBeGreaterThanOrEqual(4);
		expect(lines.some((line) => line.includes("IMAGE"))).toBe(false);
		expect(lines.some((line) => line.includes("(pi) CODING AGENT"))).toBe(true);
		expect(lines.length).toBeLessThanOrEqual(20);
	});

	test("an image wider than the terminal is cropped horizontally", () => {
		const lines = banner({ images: imageSet({ columns: 80, rows: 6 }) }, 40, 60).render(60);
		expect(imageLines(lines).length).toBe(1);
		const line = imageLines(lines)[0]!;
		const columns = Number(/c=(\d+)/.exec(line)?.[1] ?? "0");
		expect(columns).toBeLessThan(80);
		expect(columns).toBeGreaterThan(0);
		// The crop is centred horizontally, so pixels are skipped on both sides.
		const sourceX = Number(/x=(\d+)/.exec(line)?.[1] ?? "0");
		expect(sourceX).toBeGreaterThan(0);
		expect(visibleWidth(line)).toBeLessThanOrEqual(60);
	});

	test("no images -> placeholder, not a crash", () => {
		const lines = banner({ images: undefined }).render(100);
		expect(lines.length).toBeGreaterThan(0);
		expect(lines.some((line) => line.includes("IMAGE"))).toBe(true);
		expect(lines.some((line) => line.includes("rendering"))).toBe(true);
		expect(lines.some((line) => line.includes("(pi) CODING AGENT"))).toBe(true);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(100);
	});

	test("a status is surfaced once, in the card and in the status line", () => {
		const lines = banner({ images: undefined, status: "ffmpeg not found" }).render(100);
		expect(lines.some((line) => line.includes("unavailable") && line.includes("ffmpeg not found"))).toBe(true);
		expect(lines.some((line) => line.includes("ffmpeg not found"))).toBe(true);
	});

	test("setImages(undefined) keeps the kitty layout and drops the sequence", () => {
		const component = banner();
		expect(imageLines(component.render(100)).length).toBe(1);
		component.setImages(undefined);
		const lines = component.render(100);
		expect(imageLines(lines).length).toBe(0);
		expect(lines.some((line) => line.includes("rendering"))).toBe(true);
	});
});

describe("banner: modes", () => {
	test("anim mode renders one constant line regardless of the frame index", () => {
		const component = banner({ config: { ...baseConfig, kittyMode: "anim" } });
		const first = imageLines(component.render(100))[0]!;
		expect(first).toContain("a=a,i=4242,r=1,z=63");
		expect(first).toContain("a=a,i=4242,s=3,v=1,q=2");
		component.setFrameIndex(2);
		expect(imageLines(component.render(100))[0]!).toBe(first);
	});

	test("frames mode swaps the payload but keeps c=/r=/i=", () => {
		const component = banner({ config: { ...baseConfig, kittyMode: "frames" } });
		const first = imageLines(component.render(100))[0]!;
		expect(first).not.toContain("a=f");
		component.setFrameIndex(1);
		const second = imageLines(component.render(100))[0]!;
		expect(second).not.toBe(first);
		for (const param of ["c=44", "r=20", "i=4242"]) {
			expect(first).toContain(param);
			expect(second).toContain(param);
		}
		expect(second).toContain(`${PAYLOAD}1`);
	});

	test("replaceKittyPayload preserves the header verbatim", () => {
		const set = imageSet();
		const swapped = replaceKittyPayload(set.sequence, "B".repeat(10));
		expect(swapped.startsWith("\x1b_Ga=T,f=100,q=2,C=1,c=44,r=20,i=4242;")).toBe(true);
		expect(swapped.endsWith("\x1b\\")).toBe(true);
		expect(swapped).toContain("B".repeat(10));
		expect(swapped).not.toContain(PAYLOAD);
	});

	test("freeze and static drop the animation suffix", () => {
		const frozen = banner();
		frozen.toggleFreeze();
		const frozenLine = imageLines(frozen.render(100))[0]!;
		expect(frozenLine).not.toContain("a=f");
		expect(frozenLine).not.toContain("a=a");

		const still = banner({ config: { ...baseConfig, static: true } });
		expect(imageLines(still.render(100))[0]!).not.toContain("a=f");
	});

	test("dispose clears the timer and the cached lines", () => {
		const component = banner({ config: { ...baseConfig, kittyMode: "frames" } }, 40, 100);
		component.start();
		const internals = component as unknown as { timer?: unknown; animLine?: string; images?: unknown };
		expect(internals.timer).toBeDefined();
		component.dispose();
		expect(internals.timer).toBeUndefined();
		expect(internals.animLine).toBeUndefined();
		expect(internals.images).toBeUndefined();
	});

	test("anim mode needs no timer at all", () => {
		const component = banner();
		component.start();
		expect((component as unknown as { timer?: unknown }).timer).toBeUndefined();
	});

	test("pre-composes the multi-megabyte image line outside render()", () => {
		// ~2 MB of base64 chunks; building it lazily would put a big concat on the
		// first paint, inside `render()`. `setImages()` (and the constructor) warm it.
		clearImageLineCache();
		expect(cachedImageLineCount()).toBe(0);
		const component = banner({ config: { ...baseConfig, kittyMode: "anim" } });
		expect(cachedImageLineCount()).toBeGreaterThan(0);
		component.setImages(imageSet());
		expect(cachedImageLineCount()).toBeGreaterThan(0);
		component.setImages(undefined);
		expect(cachedImageLineCount()).toBe(0);
	});

	test("hidden banner renders nothing", () => {
		const component = banner();
		component.setVisible(false);
		expect(component.render(100)).toEqual([]);
	});

	test("statusLine reports the renderer", () => {
		expect(banner().statusLine()).toContain("mode=kitty");
		const chars = banner({ renderer: "chars" });
		expect(chars.statusLine()).toContain("mode=chars");
	});

	test("very narrow terminals use the compact splash, no image", () => {
		const lines = banner({ images: imageSet({ columns: 8, rows: 4 }) }, 40, 28).render(28);
		expect(lines.length).toBe(3);
		expect(imageLines(lines).length).toBe(0);
	});
});

describe("banner: terminal lifecycle", () => {
	function harness(rows = 40, columns = 100, sink: string[] = []) {
		const terminal = { rows, columns, write: (data: string) => void sink.push(data) };
		const tui = { mode: "regular", terminal, requestRender: () => undefined } as unknown as TUI;
		const component = new Banner(tui, theme, {
			config: baseConfig,
			resources: resources(),
			renderer: "kitty",
			images: imageSet(),
		});
		return { terminal, component, sink };
	}

	const idOf = (line: string) => /\bi=(\d+)/.exec(line)?.[1];

	test("dispose frees the image synchronously, before the process can exit", () => {
		const sink: string[] = [];
		const { component } = harness(40, 100, sink);
		component.render(100);
		component.dispose();
		expect(sink.join("")).toContain("\x1b_Ga=d,d=I,i=4242,q=2\x1b\\");
	});

	test("dropping the image set frees the old id, deferred past the frame", async () => {
		const sink: string[] = [];
		const { component } = harness(40, 100, sink);
		component.render(100);
		component.setImages(undefined);
		expect(sink.join("")).toBe("");
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(sink.join("")).toContain("a=d,d=I,i=4242");
	});

	test("a resize retransmits under a fresh id so pi cannot reuse a stale placement", async () => {
		const sink: string[] = [];
		const { terminal, component } = harness(40, 100, sink);
		const before = imageLines(component.render(100))[0]!;
		expect(idOf(before)).toBe("4242");

		terminal.rows = 30;
		terminal.columns = 90;
		const after = imageLines(component.render(90))[0]!;
		const id = idOf(after);
		expect(id).toBeDefined();
		expect(id).not.toBe("4242");
		expect(after).not.toContain("i=4242");
		// The retransmission is a complete root frame, not a bare placement.
		expect(after).toContain("a=T");
		expect(after).toContain("f=100");
		expect(after).toContain(`i=${id}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(sink.join("")).toContain("a=d,d=I,i=4242");
	});

	test("re-rendering at an unchanged size keeps the transmitted line", () => {
		const { component } = harness(40, 100);
		const first = imageLines(component.render(100))[0]!;
		const again = imageLines(component.render(100))[0]!;
		expect(again).toBe(first);
	});

	test("a resize crops the retransmitted frame to the new body", () => {
		const { terminal, component } = harness(40, 100);
		// The default 44x20 picture fits a 33-row body verbatim.
		expect(parseKittyRows(imageLines(component.render(100))[0]!)).toBe(20);
		terminal.rows = 26;
		const line = imageLines(component.render(100))[0]!;
		expect(parseKittyRows(line)).toBeLessThan(20);
		expect(line).toContain("h=");
	});

	test("a terminal without write() degrades silently", () => {
		const tui = { mode: "regular", terminal: { rows: 40, columns: 100 }, requestRender: () => undefined } as unknown as TUI;
		const component = new Banner(tui, theme, {
			config: baseConfig,
			resources: resources(),
			renderer: "kitty",
			images: imageSet(),
		});
		component.render(100);
		expect(() => component.dispose()).not.toThrow();
	});

	test("chars renderer never writes graphics escapes", () => {
		const sink: string[] = [];
		const terminal = { rows: 40, columns: 100, write: (data: string) => void sink.push(data) };
		const tui = { mode: "regular", terminal, requestRender: () => undefined } as unknown as TUI;
		const component = new Banner(tui, theme, {
			config: baseConfig,
			resources: resources(),
			renderer: "chars",
			frames: undefined,
			images: imageSet(),
		});
		component.render(100);
		component.dispose();
		expect(sink.join("")).toBe("");
	});
});
