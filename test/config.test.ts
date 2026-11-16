import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
	DEFAULTS,
	DEFAULT_FILE,
	DEFAULT_LAYOUT,
	applyPlanWidth,
	applySourceSize,
	autoHeightFor,
	configPath,
	describeConfig,
	describeConfigSource,
	loadConfig,
	parseLayoutTree,
	parseSize,
	pluginRoot,
	translateLegacyConfig,
	validateSettings,
	type LayoutNode,
} from "../src/config.ts";

const ROOT = "/tmp/plugin-root";

/** Load a JSON text as if it were `<ROOT>/pi-chafa-banner.json`. */
function load(json: string | undefined) {
	return loadConfig({ root: ROOT, read: (path) => (path === configPath(ROOT) ? json : undefined) });
}

const loadObject = (value: unknown) => load(JSON.stringify(value));

/** The v2 tree of the default splash, spelled out so the tests do not mirror code. */
const V2_DEFAULT_TREE = {
	type: "layout",
	mode: "horizontal",
	children: [
		{
			type: "layout",
			mode: "vertical",
			children: [
				{ type: "chafa" },
				{
					type: "window",
					title: "CODING AGENT",
					content: [
						{ type: "inline", title: "Version", content: "version" },
						{ type: "inline", title: "Model", content: "model" },
					],
				},
			],
		},
		{
			type: "window",
			title: "RESOURCES",
			content: [
				{ type: "outline", title: "Context", content: "context" },
				{ type: "outline", title: "Skills", content: "skills" },
				{ type: "outline", title: "Extensions", content: "extensions", stacked: true },
			],
		},
	],
};

const warningsOf = (json: string | undefined): string => load(json).source.warnings.join("\n");

describe("config: file discovery", () => {
	it("looks for pi-chafa-banner.json inside the package root", () => {
		expect(configPath(ROOT)).toBe(join(ROOT, "pi-chafa-banner.json"));
	});

	it("resolves the package root by walking up to a package.json", () => {
		const root = pluginRoot();
		expect(root.endsWith("pi-chafa-banner")).toBe(true);
	});

	it("falls back to built-in defaults when the file is absent", () => {
		const config = load(undefined);
		expect(config.size).toEqual(DEFAULTS.size);
		expect(config.fps).toBe(DEFAULTS.fps);
		expect(config.stride).toBe(DEFAULTS.stride);
		expect(config.source.path).toBeUndefined();
		expect(config.source.warnings).toEqual([]);
		expect(describeConfigSource(config)).toContain("built-in defaults");
	});
});

describe("config: v2 file", () => {
	it("applies a complete file", () => {
		const config = loadObject({
			version: 2,
			width: 100,
			height: 30,
			gap: 4,
			variableWidth: true,
			variableHeight: false,
			compactWidth: 40,
			image: { path: "/art/cat.gif", fps: 12, stride: 2, chafa: "--symbols block" },
			layout: {
				type: "layout",
				mode: "horizontal",
				children: [
					{ type: "chafa" },
					{
						type: "window",
						weight: 3,
						title: "RESOURCES",
						content: [
							{ type: "outline", title: "Skills", content: "skills" },
							{ type: "inline", title: "Note", content: "hello" },
						],
					},
				],
			},
			theme: { preset: "pi", border: "#ff0000" },
			behavior: { static: true, hidePiResourceList: false },
		});
		expect(config.gifPath).toBe("/art/cat.gif");
		expect(config.splash).toEqual({
			width: 100,
			height: 30,
			// A single number still means "this many cells on both axes".
			gap: { width: 4, height: 4 },
			variableWidth: true,
			variableHeight: false,
			compactWidth: 40,
		});
		// weights 1:3 over 100-4 usable columns -> 24 for the only chafa node
		expect(config.plans).toHaveLength(1);
		expect(config.plans[0]).toMatchObject({ path: "root.0", width: 24, height: autoHeightFor(24) });
		expect(config.size).toEqual({ width: 24, height: autoHeightFor(24) });
		expect(config.layoutTree).toBeDefined();
		expect(config.layoutError).toBeUndefined();
		expect(config.fps).toBe(12);
		expect(config.stride).toBe(2);
		expect(config.chafaArgs).toEqual(["--symbols", "block"]);
		expect(config.theme).toMatchObject({ preset: "pi", border: "#ff0000" });
		expect(config.static).toBe(true);
		expect(config.hideResources).toBe(false);
		expect(config.source.path).toBe(configPath(ROOT));
	});

	it("keeps defaults for keys the file omits", () => {
		const config = loadObject({ image: { fps: 12 } });
		expect(config.splash).toEqual({
			width: DEFAULT_FILE.width,
			// The default floor: content may make the splash taller, never shorter.
			height: 17,
			// Columns between siblings; rows are free by default.
			gap: { width: 2, height: 1 },
			variableWidth: DEFAULT_FILE.variableWidth,
			variableHeight: DEFAULT_FILE.variableHeight,
			compactWidth: DEFAULT_FILE.compactWidth,
		});
		expect(config.layoutTree).toEqual(DEFAULT_LAYOUT);
		expect(config.layoutError).toBeUndefined();
		expect(config.fps).toBe(12);
		expect(config.stride).toBe(DEFAULTS.stride);
		expect(config.size).toEqual(DEFAULTS.size);
	});

	it("resolves a relative image path against the package root and expands ~", () => {
		expect(loadObject({ image: { path: "art/x.gif" } }).gifPath).toBe(join(ROOT, "art", "x.gif"));
		expect(loadObject({ image: { path: "~/a.gif" } }).gifPath).toContain("a.gif");
		expect(loadObject({ image: { path: "~/a.gif" } }).gifPath?.startsWith("~")).toBe(false);
	});

	it("describes itself for /splash status", () => {
		const text = describeConfig(loadObject({ width: 102, height: 28, gap: 2, variableHeight: false }));
		expect(text).toContain("image=50x25 (derived)");
		expect(text).toContain("width=102");
		expect(text).toContain("height=28");
		expect(text).toContain("gap=2");
		expect(text).toContain("nodes=");
	});
});

describe("config: layout tree", () => {
	it("solves the chafa canvas from config + weights + gap", () => {
		const config = loadObject({ width: 100, gap: 4, layout: V2_DEFAULT_TREE });
		// 96 usable columns, 5:5 split -> 48 per column
		expect(config.plans).toHaveLength(1);
		expect(config.plans[0]).toMatchObject({ width: 48, height: autoHeightFor(48) });
		expect(config.size).toEqual({ width: 48, height: autoHeightFor(48) });
	});

	it("defaults a missing weight to 1 and humanizes a missing content title", () => {
		const parsed = parseLayoutTree({
			type: "layout",
			children: [
				{ type: "chafa" },
				{ type: "window", content: [{ type: "outline", content: "version" }] },
			],
		});
		expect(parsed.error).toBeUndefined();
		const window = (parsed.tree as Extract<LayoutNode, { type: "layout" }>).children[1] as Extract<
			LayoutNode,
			{ type: "window" }
		>;
		expect(window.weight).toBe(1);
		// no title in the file: the renderer keeps its own default heading
		expect(window.title).toBeUndefined();
		expect(window.content[0]).toEqual({ type: "outline", title: "Version", content: "version" });
	});

	it("caps an absurd weight instead of failing the whole tree", () => {
		const parsed = parseLayoutTree({ type: "layout", children: [{ type: "chafa", weight: 5000 }] });
		expect(parsed.error).toBeUndefined();
		const group = parsed.tree as Extract<LayoutNode, { type: "layout" }>;
		expect(group.children[0]?.weight).toBe(100);
	});

	it("does not leak changes back into DEFAULT_LAYOUT", () => {
		const first = parseLayoutTree(undefined).tree as Extract<LayoutNode, { type: "window" | "layout" }>;
		expect(first).toEqual(DEFAULT_LAYOUT);
		expect(parseLayoutTree(undefined).tree).not.toBe(DEFAULT_LAYOUT);
	});
});

describe("config: structural layout errors", () => {
	const errorOf = (layout: unknown): string | undefined => parseLayoutTree(layout).error;

	it("reports an unknown node type with its JSON path", () => {
		expect(
			errorOf({
				type: "layout",
				children: [{ type: "chafa" }, { type: "chart" }],
			}),
		).toBe('layout.children[1].type: expected one of chafa, layout, window (got "chart")');
	});

	it("reports a layout without children", () => {
		expect(errorOf({ type: "layout" })).toContain("layout.children: expected a non-empty array");
	});

	it("reports a window without content", () => {
		expect(errorOf({ type: "window", title: "X" })).toContain("layout.content: expected an array");
	});

	it("reports an invalid weight", () => {
		expect(errorOf({ type: "layout", children: [{ type: "chafa", weight: 0 }] })).toBe(
			"layout.children[0].weight: expected a positive number (got 0)",
		);
	});

	it("reports a non-object node", () => {
		expect(errorOf({ type: "layout", children: ["chafa"] })).toContain("layout.children[0]: expected an object");
	});

	it("reports an invalid mode", () => {
		expect(errorOf({ type: "layout", mode: "diagonal", children: [{ type: "chafa" }] })).toContain(
			'layout.mode: expected "horizontal" or "vertical" (got "diagonal")',
		);
	});

	it("reports a content entry without a known type", () => {
		expect(
			errorOf({
				type: "layout",
				children: [{ type: "window", content: [{ type: "bullet", content: "x" }] }],
			}),
		).toBe('layout.children[0].content[0].type: expected one of inline, outline (got "bullet")');
	});

	it("reports a non-object tree root", () => {
		expect(errorOf("nope")).toBe('layout: expected an object (got "nope")');
	});

	it("keeps a broken tree out of the rendered config", () => {
		const config = loadObject({
			width: 120,
			layout: { type: "layout", children: [{ type: "chart" }] },
		});
		expect(config.layoutError).toBe(
			'layout.children[0].type: expected one of chafa, layout, window (got "chart")',
		);
		expect(config.layoutTree).toBeUndefined();
		expect(config.plans).toEqual([]);
		expect(config.panels.info.fields).toEqual([]);
		expect(config.panels.resources.enabled).toBe(false);
		expect(describeConfig(config)).toContain("layout=error");
	});

	it("reports the layout error as a warning, so reload and status can show it", () => {
		const config = loadObject({
			width: 120,
			layout: { type: "layout", children: [{ type: "chart" }] },
		});
		// `/splash reload` and `/splash status` print `source.warnings`; without this
		// entry the card was the only place the reason existed.
		expect(config.source.warnings.join("\n")).toContain(`layout: ${config.layoutError}`);
	});

	it("warns about optional fields whose type is wrong instead of dropping them silently", () => {
		const parsed = parseLayoutTree({
			type: "layout",
			children: [
				{ type: "chafa", img: 42, args: 7 },
				{ type: "window", title: 9, content: [{ type: "inline", content: "version", stacked: "yes" }] },
			],
		});
		expect(parsed.error).toBeUndefined();
		const text = parsed.warnings.join("\n");
		expect(text).toContain("layout.children[0].img");
		expect(text).toContain("layout.children[0].args");
		expect(text).toContain("layout.children[1].title");
		expect(text).toContain("layout.children[1].content[0].stacked");
	});

	it("warns once when a title or value carries control characters", () => {
		const parsed = parseLayoutTree({
			type: "layout",
			children: [
				{
					type: "window",
					title: "A\nB",
					content: [{ type: "inline", title: "V", content: "x\ty" }],
				},
			],
		});
		expect(parsed.error).toBeUndefined();
		const text = parsed.warnings.join("\n");
		expect(text).toContain("layout.children[0].title");
		expect(text).toContain("layout.children[0].content[0].content");
		expect(text).toContain("replaced with spaces");
	});
});

describe("config: v1 translation", () => {
	it("translates the flat layout and panels groups into a tree", () => {
		const config = loadObject({
			version: 1,
			image: { path: "/art/cat.gif" },
			layout: { width: 100, gap: 6, lowerRows: 14 },
			panels: {
				info: { fields: ["model"] },
				resources: { sections: ["skills"], maxLinesPerSection: 3 },
			},
			behavior: { static: true, hidePiResourceList: false },
		});
		// A v1 gap only ever separated the two columns.
		expect(config.splash).toMatchObject({ width: 100, gap: { width: 6, height: 0 } });
		expect(config.layoutError).toBeUndefined();
		expect(config.size).toEqual({ width: 47, height: autoHeightFor(47) });
		expect(config.panels.info.fields).toEqual(["model"]);
		expect(config.panels.resources.sections).toEqual(["skills"]);
		expect(config.static).toBe(true);
		expect(config.hideResources).toBe(false);
		expect(config.source.warnings[0]).toContain("version 1 config: translated to the layout tree");
		expect(config.source.warnings[0]).toContain("width=100");
	});

	it("keeps the default panels when a v1 file lists none", () => {
		const legacy = translateLegacyConfig({ version: 1, layout: { width: 90 } });
		expect(legacy.width).toBe(90);
		expect(legacy.warnings.join("\n")).toContain("version 1 config");
		const config = loadObject({ version: 1, layout: { width: 90 } });
		expect(config.panels.info.fields).toEqual(["version", "model"]);
		expect(config.panels.resources.sections).toEqual(["context", "skills", "extensions"]);
		expect(config.plans).toHaveLength(1);
	});

	it("drops the window of a panel the v1 file disabled", () => {
		const config = loadObject({
			version: 1,
			panels: { info: { enabled: false }, resources: { enabled: false } },
		});
		// The old renderer really omitted the card, so translation has to remove the
		// window; keeping it with default content would re-open what the user closed.
		expect(config.layoutError).toBeUndefined();
		expect(config.panels.info.fields).toEqual([]);
		expect(config.panels.resources.sections).toEqual([]);
		const titles = JSON.stringify(config.layoutTree);
		expect(titles).not.toContain("CODING AGENT");
		expect(titles).not.toContain("RESOURCES");
		expect(config.plans).toHaveLength(1);
		expect(config.source.warnings.join("\n")).toContain("dropped when translating");
	});

	it("warns about every v1 key it has to drop", () => {
		const warnings = warningsOf(
			JSON.stringify({
				version: 1,
				layout: { width: 150, maxWidth: 108, twoColumnMinWidth: 90, lowerRows: 30 },
				panels: { resources: { width: "auto", height: 20 } },
			}),
		);
		for (const key of ["maxWidth", "twoColumnMinWidth", "lowerRows", "resources.width", "resources.height"]) {
			expect(warnings).toContain(key);
		}
	});

	it("warns about an unknown field inside panels", () => {
		const warnings = warningsOf(JSON.stringify({ version: 1, panels: { info: { fields: ["version", "bogus"] } } }));
		expect(warnings).toContain("bogus");
	});

	it("reports a version that matches neither shape", () => {
		expect(warningsOf(JSON.stringify({ version: 3, width: 100 }))).toContain("version");
		expect(warningsOf(JSON.stringify({ version: "2", width: 100 }))).toContain("version");
	});

	it("warns about v1 keys without a tree equivalent", () => {
		const warnings = warningsOf(
			JSON.stringify({
				version: 1,
				panels: { info: { fields: ["version", "gif"] }, resources: { maxLinesPerSection: 4 } },
			}),
		);
		expect(warnings).toContain("panels.info.fields");
		expect(warnings).toContain("maxLinesPerSection");
	});

	it("treats layout.type or layout.children as v2", () => {
		const config = loadObject({
			version: 1,
			layout: { type: "layout", children: [{ type: "chafa" }] },
		});
		expect(config.layoutTree).toBeDefined();
		expect(config.source.warnings.join("\n")).toContain("version: expected 2");
	});
});

describe("config: tolerance", () => {
	it("warns once about invalid JSON and keeps defaults", () => {
		const config = load("{ not json");
		expect(config.size).toEqual(DEFAULTS.size);
		expect(config.source.warnings).toHaveLength(1);
		expect(config.source.warnings[0]).toContain("invalid JSON");
	});

	it("drops only the offending fields", () => {
		const config = loadObject({
			image: { fps: 100, chafa: 42 },
			width: "wide",
			gap: 20,
			height: 200,
			variableWidth: "yes",
			compactWidth: 5,
		});
		// width falls back to 88, but gap clamps to 12, so the canvas is (88-12)/2 = 38
		expect(config.size.width).toBe(38);
		expect(config.fps).toBe(30); // clamped, not dropped
		expect(config.chafaArgs).toEqual([]);
		expect(config.splash.width).toBe(DEFAULT_FILE.width);
		expect(config.splash.gap).toEqual({ width: 12, height: 12 }); // clamped
		expect(config.splash.height).toBe(80); // clamped
		expect(config.splash.variableWidth).toBe(DEFAULT_FILE.variableWidth);
		expect(config.splash.compactWidth).toBe(20); // clamped
		const warnings = config.source.warnings.join("\n");
		expect(warnings).toContain("image.chafa");
		expect(warnings).toContain("width: expected a number");
		expect(warnings).toContain("variableWidth: expected true or false");
	});

	it("ignores unknown keys", () => {
		const config = loadObject({ unknownTopLevel: 42, image: { nope: 1 }, nonsense: { deep: true } });
		expect(config.source.warnings).toEqual([]);
		expect(config.size).toEqual(DEFAULTS.size);
	});

	it("warns but still reads a file with an unexpected version", () => {
		const config = loadObject({
			version: 3,
			layout: { type: "layout", children: [{ type: "chafa" }] },
		});
		expect(config.source.warnings.join("\n")).toContain("version: expected 2, got 3");
	});

	it("treats a non-object root as defaults", () => {
		const settings = validateSettings([1, 2, 3]);
		expect(settings.splash.width).toBe(DEFAULT_FILE.width);
		expect(settings.warnings.join("\n")).toContain("root");
	});

	it("treats a non-object group as defaults", () => {
		const settings = validateSettings({ image: "nope" });
		expect(settings.image.fps).toBe(DEFAULTS.fps);
		expect(settings.warnings.join("\n")).toContain("image: expected an object");
	});
});

describe("config: root height", () => {
	it('"auto" means exactly as tall as the content needs', () => {
		const config = loadObject({ height: "auto" });
		expect(config.splash.height).toBeNull();
		// not a warning: "auto" is a documented value, just not the default
		expect(config.source.warnings).toEqual([]);
		expect(loadObject({}).splash.height).toBe(17);
	});

	it("a number is kept as the floor, out-of-range values clamp", () => {
		expect(loadObject({ height: 30 }).splash.height).toBe(30);
		expect(loadObject({ height: 500 }).splash.height).toBe(80);
		expect(warningsOf('{"height": 500}')).toContain("clamped to 80");
	});

	it("a nonsense value falls back to the default and warns", () => {
		const config = loadObject({ height: "tall" });
		expect(config.splash.height).toBe(17);
		expect(config.source.warnings.join("\n")).toContain('height: expected "auto" or a number between 4 and 80');
	});

	it("describeConfig prints auto, a floor, and the per-axis gaps", () => {
		expect(describeConfig(loadObject({ height: "auto" }))).toContain("height=auto");
		const text = describeConfig(loadObject({}));
		expect(text).toContain("height=17");
		expect(text).not.toContain("height=17+");
		expect(text).toContain("gap=2/1");
	});
});

describe("config: per-terminal canvases", () => {
	it("re-solves the canvas for a narrower box and keeps the aspect", () => {
		const config = loadObject({ width: 88, gap: 2 });
		const narrow = applyPlanWidth(config, 60);
		expect(narrow).not.toBe(config);
		expect(narrow.planWidth).toBe(60);
		// (60 - 2) / 2 columns per side, height from the plan's own aspect ratio
		expect(narrow.plans[0]?.width).toBe(29);
		expect(narrow.plans[0]?.width).toBeLessThan(config.plans[0]!.width);
		expect(narrow.size).toEqual({ width: 29, height: narrow.plans[0]!.height });
	});

	it("returns the same object when the width already matches", () => {
		const config = loadObject({ width: 88, gap: 2 });
		expect(applyPlanWidth(config, config.planWidth)).toBe(config);
	});

	it("clamps the target width to the documented range", () => {
		const config = loadObject({ width: 88, gap: 2 });
		expect(applyPlanWidth(config, 400).planWidth).toBe(160);
	});
});

describe("config: derived canvas", () => {
	it("refines the height from the artwork aspect ratio", () => {
		const config = loadObject({ width: 82, gap: 2 });
		expect(config.size.width).toBe(40);
		const square = applySourceSize(config, { width: 500, height: 500 });
		expect(square.size.height).toBe(20);
		const wide = applySourceSize(config, { width: 1000, height: 250 });
		expect(wide.size.height).toBe(5);
		expect(wide.plans[0]?.height).toBe(5);
	});

	it("keeps the derived height when the aspect ratio already matches", () => {
		const config = loadObject({ width: 82, gap: 2 });
		expect(applySourceSize(config, { width: 1000, height: 1000 })).toBe(config);
	});

	it("ignores width and height inside image: the canvas is derived", () => {
		const config = loadObject({ image: { width: 20, height: 5 } });
		expect(config.size).toEqual(DEFAULTS.size);
		expect(config.source.warnings).toEqual([]);
	});
});

describe("config: helpers", () => {
	it("parses WxH sizes", () => {
		expect(parseSize("50x30")).toEqual({ width: 50, height: 30 });
		expect(parseSize("50X30")).toEqual({ width: 50, height: 30 });
		expect(parseSize(undefined, { width: 40, height: 20 })).toEqual({ width: 40, height: 20 });
		expect(parseSize("nope", { width: 40, height: 20 })).toEqual({ width: 40, height: 20 });
		expect(parseSize("1000x1000")).toEqual({ width: 160, height: 80 });
	});

	it("keeps the defaults self-consistent", () => {
		expect(DEFAULTS.version).toBe(2);
		expect(DEFAULTS.size).toEqual({ width: 43, height: 22 });
		expect(DEFAULTS.plans).toHaveLength(1);
		expect(DEFAULTS.chafaArgs).toEqual([]);
		expect(DEFAULTS.splash).toEqual({
			width: 88,
			// Fits the 12-row canvas plus the two-row info card at width 88.
			height: 17,
			// Blank cells per axis; one row looks like two columns.
			gap: { width: 2, height: 1 },
			// Both are hard limits by default: overflow is marked with `...`.
			variableWidth: false,
			variableHeight: false,
			compactWidth: 32,
		});
	});
});
