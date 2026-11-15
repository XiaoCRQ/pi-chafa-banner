import { describe, expect, test } from "bun:test";
import { Banner } from "../src/banner.ts";
import { DEFAULTS, type BannerConfig } from "../src/config.ts";
import { CHROME_ROWS, plainPainter } from "../src/layout.ts";
import type { FrameSet } from "../src/frames.ts";
import { emptyResources, type BannerResources } from "../src/resources.ts";
import type { Theme, TUI } from "@earendil-works/pi-coding-agent";
import { maxVisibleWidth, visibleWidth } from "../src/text.ts";

const theme: Theme = {
	fg: (_token, text) => text,
	bg: (_token, text) => text,
	bold: (text) => text,
	italic: (text) => text,
	underline: (text) => text,
	getColorMode: () => "truecolor",
};

function fakeTui(rows = 40): TUI {
	const state = { renders: 0 };
	return {
		mode: "inline",
		terminal: { rows, columns: 100 },
		requestRender: () => {
			state.renders += 1;
		},
	} as unknown as TUI;
}

const config: BannerConfig = { ...DEFAULTS, gifPath: "/tmp/x.gif", enabled: true, fps: 30, stride: 1, static: false };

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

function frames(count = 3): FrameSet {
	const frames = Array.from({ length: count }, (_, index) =>
		Array.from({ length: 12 }, () => `▀▄${index % 10}`.repeat(8).slice(0, 44)),
	);
	return {
		frames,
		width: 44,
		height: 12,
		colorMode: "truecolor",
		gifPath: "/tmp/x.gif",
		totalFrames: count,
		stride: 1,
		delays: Array.from({ length: count }, () => 100),
		fromCache: true,
		builtAt: Date.now(),
	};
}

function makeBanner(overrides: Partial<{ frames: FrameSet; status: string; cfg: BannerConfig; rows: number }> = {}) {
	const tui = fakeTui(overrides.rows ?? 40);
	const banner = new Banner(tui, theme, {
		config: overrides.cfg ?? config,
		resources: resources(),
		frames: overrides.frames,
		status: overrides.status,
	});
	return { banner, tui };
}

describe("Banner.render width contract", () => {
	for (const width of [20, 31, 40, 60, 75, 76, 90, 108, 140]) {
		test(`never exceeds ${width} columns`, () => {
			const { banner } = makeBanner({ frames: frames() });
			const lines = banner.render(width);
			expect(lines.length).toBeGreaterThan(0);
			for (const line of lines) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				// A returned line must not embed newlines (pi treats 1 entry = 1 row).
				expect(line.includes("\n")).toBe(false);
			}
			banner.dispose();
		});
	}

	test("uses the compact splash below 32 columns", () => {
		const { banner } = makeBanner({ frames: frames() });
		const lines = banner.render(24);
		expect(lines.length).toBe(3);
		banner.dispose();
	});

	test("stacks the panel below the art on narrow terminals", () => {
		const { banner } = makeBanner({ frames: frames() });
		const stacked = banner.render(60);
		const wide = banner.render(100);
		expect(stacked.length).toBeGreaterThan(wide.length);
		expect(stacked.join("\n")).toContain("RESOURCES");
		banner.dispose();
	});

	test("lines are padded to a common block width", () => {
		const { banner } = makeBanner({ frames: frames() });
		const lines = banner.render(100).filter((line) => line.includes("│") || line.includes("╭"));
		const widths = new Set(lines.map((line) => visibleWidth(line.trimEnd())));
		expect(widths.size).toBe(1);
		banner.dispose();
	});
});

describe("Banner degraded states", () => {
	test("shows a placeholder before frames arrive", () => {
		const { banner } = makeBanner();
		const lines = banner.render(100);
		expect(lines.join("\n")).toContain("rendering chafa frames");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(100);
		banner.dispose();
	});

	test("surfaces the failure status in the placeholder", () => {
		const { banner } = makeBanner({ status: "missing chafa on PATH" });
		const text = banner.render(100).join("\n");
		expect(text).toContain("unavailable");
		expect(text).toContain("missing chafa on PATH");
		banner.dispose();
	});

	test("a short terminal clips the art but keeps the info card", () => {
		const { banner } = makeBanner({ frames: frames(), rows: 18 });
		const lines = banner.render(100);
		// An 11-row body: the info card (5 rows + its blank) keeps its room and the
		// 12-row artwork is clipped to what is left, so nothing overflows.
		expect(lines.length).toBe(11);
		expect(lines.join("\n")).toContain("(pi) CODING AGENT");
		banner.dispose();
	});

	test("chars mode emits every art row, like the native band", () => {
		// Both renderers share one layout: the picture is never shortened, so the
		// character canvas keeps all 12 rows on a 30-row terminal too.
		const { banner } = makeBanner({ frames: frames(), rows: 30 });
		const lines = banner.render(60);
		expect(lines.length).toBeGreaterThanOrEqual(13);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(60);
		banner.dispose();
	});

	test("renders nothing when hidden", () => {
		const { banner } = makeBanner({ frames: frames() });
		banner.setVisible(false);
		expect(banner.render(100)).toEqual([]);
		banner.dispose();
	});

	test("a single frame does not start a timer", () => {
		const { banner } = makeBanner({ frames: frames(1) });
		banner.start();
		expect(banner.isFrozen()).toBe(false);
		expect(banner.render(100).length).toBeGreaterThan(0);
		banner.dispose();
	});
});

describe("Banner animation controls", () => {
	test("freeze/unfreeze is reported", () => {
		const { banner } = makeBanner({ frames: frames() });
		expect(banner.toggleFreeze()).toBe(true);
		expect(banner.isFrozen()).toBe(true);
		expect(banner.toggleFreeze()).toBe(false);
		banner.dispose();
	});

	test("setFrameIndex wraps around", () => {
		const { banner } = makeBanner({ frames: frames(3) });
		banner.setFrameIndex(4);
		expect(banner.render(100).join("\n")).toContain("▀▄1");
		banner.setFrameIndex(-1);
		expect(banner.render(100).join("\n")).toContain("▀▄2");
		banner.dispose();
	});

	test("statusLine summarizes the state", () => {
		const { banner } = makeBanner({ frames: frames() });
		expect(banner.statusLine()).toContain("size=44x22");
		expect(banner.statusLine()).toContain("frames=3/3");
		banner.dispose();
	});

	test("static config renders a single frame", () => {
		const { banner } = makeBanner({ frames: frames(), cfg: { ...config, static: true } });
		expect(banner.isFrozen()).toBe(true);
		const first = banner.render(100);
		banner.setFrameIndex(2);
		expect(banner.render(100)).not.toEqual(first);
		banner.dispose();
	});
});

describe("Banner resources", () => {
	test("missing sections render as (none)", () => {
		const { banner } = makeBanner({ frames: frames() });
		banner.setResources({ ...emptyResources(), version: "1.5.2" });
		expect(banner.render(100).join("\n")).toContain("(none)");
		banner.dispose();
	});

	test("maxVisibleWidth of the rendered block is stable across frames", () => {
		const { banner } = makeBanner({ frames: frames() });
		const widths = new Set(
			Array.from({ length: 3 }, (_, index) => {
				banner.setFrameIndex(index);
				return maxVisibleWidth(banner.render(100));
			}),
		);
		expect(widths.size).toBe(1);
		banner.dispose();
	});
});

describe("plainPainter", () => {
	test("returns text unchanged", () => {
		expect(plainPainter.fg("accent", "x")).toBe("x");
		expect(plainPainter.bold("x")).toBe("x");
	});
});
