import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import {
	DEFAULTS,
	applySourceSize,
	autoHeightFor,
	configPath,
	describeConfig,
	describeConfigSource,
	loadConfig,
	paletteOf,
	parseSize,
	pluginRoot,
	validateSettings,
} from "../src/config.ts";

const ROOT = "/tmp/plugin-root";

/** Load a JSON text as if it were `<ROOT>/pi-chafa-banner.json`. */
function load(json: string | undefined) {
	return loadConfig({ root: ROOT, read: (path) => (path === configPath(ROOT) ? json : undefined) });
}

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
		expect(config.source.path).toBeUndefined();
		expect(config.source.warnings).toEqual([]);
		expect(describeConfigSource(config)).toContain("built-in defaults");
	});
});

describe("config: reading values", () => {
	it("applies a complete file", () => {
		const config = load(
			JSON.stringify({
				version: 1,
				image: { path: "/art/cat.gif", width: 60, height: 18, fps: 12, stride: 2, renderer: "chars" },
				layout: { width: 100, gap: 6, lowerRows: 14 },
				panels: { info: { enabled: false, fields: ["model"] }, resources: { sections: ["skills"], maxLinesPerSection: 3 } },
				behavior: { static: true, hidePiResourceList: false },
			}),
		);
		expect(config.gifPath).toBe("/art/cat.gif");
		expect(config.size).toEqual({ width: 60, height: 18 });
		expect(config.heightAuto).toBe(false);
		expect(config.fps).toBe(12);
		expect(config.stride).toBe(2);
		expect(config.renderer).toBe("chars");
		expect(config.layout).toMatchObject({ width: 100, gap: 6, lowerRows: 14 });
		expect(config.panels.info).toEqual({ enabled: false, fields: ["model"] });
		expect(config.panels.resources.sections).toEqual(["skills"]);
		expect(config.panels.resources.maxLinesPerSection).toBe(3);
		expect(config.static).toBe(true);
		expect(config.hideResources).toBe(false);
		expect(config.source.path).toBe(configPath(ROOT));
	});

	it("keeps defaults for keys the file omits", () => {
		const config = load(JSON.stringify({ image: { width: 50 } }));
		expect(config.size.width).toBe(50);
		expect(config.fps).toBe(DEFAULTS.fps);
		expect(config.layout).toEqual(DEFAULTS.layout);
		expect(config.panels).toEqual(DEFAULTS.panels);
	});

	it("resolves a relative image path against the package root and expands ~", () => {
		expect(load(JSON.stringify({ image: { path: "art/x.gif" } })).gifPath).toBe(join(ROOT, "art", "x.gif"));
		expect(load(JSON.stringify({ image: { path: "~/a.gif" } })).gifPath).toContain("a.gif");
		expect(load(JSON.stringify({ image: { path: "~/a.gif" } })).gifPath?.startsWith("~")).toBe(false);
	});

	it("describes itself for /splash status", () => {
		const text = describeConfig(load(JSON.stringify({ image: { width: 50, height: 25 } })));
		expect(text).toContain("image=50x25");
		expect(text).toContain("layout=88");
	});
});

describe("config: auto height", () => {
	it("derives the height from the width when height is auto", () => {
		const config = load(JSON.stringify({ image: { width: 60 } }));
		expect(config.heightAuto).toBe(true);
		expect(config.size.height).toBe(autoHeightFor(60));
	});

	it("refines the height from the artwork aspect ratio", () => {
		const config = load(JSON.stringify({ image: { width: 40 } }));
		const square = applySourceSize(config, { width: 500, height: 500 });
		expect(square.size.height).toBe(20);
		const wide = applySourceSize(config, { width: 1000, height: 250 });
		expect(wide.size.height).toBe(5);
	});

	it("never overrides an explicit height", () => {
		const config = load(JSON.stringify({ image: { width: 40, height: 30 } }));
		expect(applySourceSize(config, { width: 1000, height: 250 })).toBe(config);
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
		const config = load(
			JSON.stringify({
				image: { width: "wide", fps: 100, renderer: "sixel", height: "tall" },
				layout: { gap: true },
			}),
		);
		expect(config.size.width).toBe(DEFAULTS.size.width);
		expect(config.fps).toBe(30); // clamped, not dropped
		expect(config.renderer).toBe("auto");
		expect(config.heightAuto).toBe(true);
		expect(config.layout.gap).toBe(DEFAULTS.layout.gap);
		expect(config.source.warnings.join("\n")).toContain("image.width");
		expect(config.source.warnings.join("\n")).toContain("image.renderer");
		expect(config.source.warnings.join("\n")).toContain("layout.gap");
	});

	it("ignores unknown keys and unknown list entries", () => {
		const config = load(
			JSON.stringify({
				unknownTopLevel: 42,
				image: { nope: 1 },
				panels: { resources: { sections: ["context", "nonsense"] } },
			}),
		);
		expect(config.panels.resources.sections).toEqual(["context"]);
		expect(config.source.warnings.join("\n")).toContain("nonsense");
	});

	it("warns but still reads a file with an unexpected version", () => {
		const config = load(JSON.stringify({ version: 2, image: { width: 52 } }));
		expect(config.size.width).toBe(52);
		expect(config.source.warnings.join("\n")).toContain("version");
	});

	it("treats a non-object root as defaults", () => {
		const settings = validateSettings([1, 2, 3]);
		expect(settings.image.width).toBe(DEFAULTS.size.width);
		expect(settings.warnings.join("\n")).toContain("root");
	});

	it("treats a non-object group as defaults", () => {
		const settings = validateSettings({ image: "nope" });
		expect(settings.image.fps).toBe(DEFAULTS.fps);
		expect(settings.warnings.join("\n")).toContain("image: expected an object");
	});

	it("collapses duplicate list entries", () => {
		const settings = validateSettings({ panels: { resources: { sections: ["themes", "themes", "skills"] } } });
		expect(settings.panels.resources.sections).toEqual(["themes", "skills"]);
	});
});

describe("config: helpers", () => {
	it("parses WxH sizes", () => {
		expect(parseSize("50x30")).toEqual({ width: 50, height: 30 });
		expect(parseSize("50X30")).toEqual({ width: 50, height: 30 });
		expect(parseSize(undefined, { width: 40, height: 20 })).toEqual({ width: 40, height: 20 });
		expect(parseSize("nope", { width: 40, height: 20 })).toEqual({ width: 40, height: 20 });
		expect(parseSize("1000x1000")).toEqual({ width: 160, height: 60 });
	});

	it("snaps palettes down to a supported size", () => {
		expect(paletteOf(1)).toBe(16);
		expect(paletteOf(200)).toBe(128);
		expect(paletteOf(256)).toBe(256);
	});

	it("keeps the defaults self-consistent", () => {
		expect(DEFAULTS.size.height).toBe(autoHeightFor(DEFAULTS.size.width));
		expect(DEFAULTS.version).toBe(1);
		expect(DEFAULTS.renderer).toBe("auto");
	});
});
