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
		expect(config.stride).toBe(DEFAULTS.stride);
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
				image: { path: "/art/cat.gif", fps: 12, stride: 2, chafa: "--symbols block" },
				layout: { width: 100, gap: 6, lowerRows: 14 },
				panels: { info: { enabled: false, fields: ["model"] }, resources: { sections: ["skills"], maxLinesPerSection: 3 } },
				behavior: { static: true, hidePiResourceList: false },
			}),
		);
		expect(config.gifPath).toBe("/art/cat.gif");
		// Two equal columns: (100 - 6) / 2 = 47 wide, 24 rows before the gif is probed.
		expect(config.size).toEqual({ width: 47, height: autoHeightFor(47) });
		expect(config.fps).toBe(12);
		expect(config.stride).toBe(2);
		expect(config.chafaArgs).toEqual(["--symbols", "block"]);
		expect(config.layout).toMatchObject({ width: 100, gap: 6, lowerRows: 14 });
		expect(config.panels.info).toEqual({ enabled: false, fields: ["model"] });
		expect(config.panels.resources.sections).toEqual(["skills"]);
		expect(config.panels.resources.maxLinesPerSection).toBe(3);
		expect(config.static).toBe(true);
		expect(config.hideResources).toBe(false);
		expect(config.source.path).toBe(configPath(ROOT));
	});

	it("keeps defaults for keys the file omits", () => {
		const config = load(JSON.stringify({ image: { fps: 12 } }));
		expect(config.size).toEqual(DEFAULTS.size);
		expect(config.fps).toBe(12);
		expect(config.stride).toBe(DEFAULTS.stride);
		expect(config.layout).toEqual(DEFAULTS.layout);
		expect(config.panels).toEqual(DEFAULTS.panels);
	});

	it("resolves a relative image path against the package root and expands ~", () => {
		expect(load(JSON.stringify({ image: { path: "art/x.gif" } })).gifPath).toBe(join(ROOT, "art", "x.gif"));
		expect(load(JSON.stringify({ image: { path: "~/a.gif" } })).gifPath).toContain("a.gif");
		expect(load(JSON.stringify({ image: { path: "~/a.gif" } })).gifPath?.startsWith("~")).toBe(false);
	});

	it("describes itself for /splash status", () => {
		const text = describeConfig(load(JSON.stringify({ layout: { width: 102, gap: 2 } })));
		expect(text).toContain("image=50x25 (derived)");
		expect(text).toContain("gap=2");
		expect(text).toContain("layout=102");
	});
});

describe("config: derived canvas", () => {
	it("splits the layout width into two equal columns", () => {
		const config = load(JSON.stringify({ layout: { width: 100, gap: 4 } }));
		expect(config.size.width).toBe(48);
		expect(config.size.height).toBe(autoHeightFor(48));
		expect(DEFAULTS.size).toEqual({ width: 43, height: 22 });
	});

	it("refines the height from the artwork aspect ratio", () => {
		const config = load(JSON.stringify({ layout: { width: 82, gap: 2 } }));
		expect(config.size.width).toBe(40);
		const square = applySourceSize(config, { width: 500, height: 500 });
		expect(square.size.height).toBe(20);
		const wide = applySourceSize(config, { width: 1000, height: 250 });
		expect(wide.size.height).toBe(5);
	});

	it("keeps the derived height when the aspect ratio already matches", () => {
		const config = load(JSON.stringify({ layout: { width: 82, gap: 2 } }));
		expect(applySourceSize(config, { width: 1000, height: 1000 })).toBe(config);
	});

	it("ignores width and height inside image: the canvas is derived", () => {
		const config = load(JSON.stringify({ image: { width: 20, height: 5 } }));
		expect(config.size).toEqual(DEFAULTS.size);
		expect(config.source.warnings).toEqual([]);
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
				image: { fps: 100, chafa: 42 },
				layout: { gap: true },
			}),
		);
		expect(config.size.width).toBe(DEFAULTS.size.width);
		expect(config.fps).toBe(30); // clamped, not dropped
		expect(config.chafaArgs).toEqual([]);
		expect(config.layout.gap).toBe(DEFAULTS.layout.gap);
		expect(config.source.warnings.join("\n")).toContain("image.chafa");
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
		const config = load(JSON.stringify({ version: 2, layout: { width: 102 } }));
		expect(config.size.width).toBe(50);
		expect(config.source.warnings.join("\n")).toContain("version");
	});

	it("treats a non-object root as defaults", () => {
		const settings = validateSettings([1, 2, 3]);
		expect(settings.layout.width).toBe(DEFAULTS.layout.width);
		expect(settings.warnings.join("\n")).toContain("root");
	});

	it("treats a non-object group as defaults", () => {
		const settings = validateSettings({ image: "nope" });
		expect(settings.image.fps).toBe(DEFAULTS.fps);
		expect(settings.warnings.join("\n")).toContain("image: expected an object");
	});

	it("collapses duplicate list entries", () => {
		const settings = validateSettings({ panels: { resources: { sections: ["context", "context", "skills"] } } });
		expect(settings.panels.resources.sections).toEqual(["context", "skills"]);
	});

	it("rejects the retired `theme` info field", () => {
		const settings = validateSettings({ panels: { info: { fields: ["version", "theme"] } } });
		expect(settings.panels.info.fields).toEqual(["version"]);
		expect(settings.warnings.join("\n")).toContain("ignored unknown entry \"theme\"");
	});

	it("rejects the retired Themes resource section", () => {
		const settings = validateSettings({ panels: { resources: { sections: ["context", "themes", "extensions"] } } });
		expect(settings.panels.resources.sections).toEqual(["context", "extensions"]);
		expect(settings.warnings.join("\n")).toContain("ignored unknown entry \"themes\"");
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

	it("keeps the defaults self-consistent", () => {
		expect(DEFAULTS.size.height).toBe(autoHeightFor(DEFAULTS.size.width));
		expect(DEFAULTS.version).toBe(1);
		expect(DEFAULTS.chafaArgs).toEqual([]);
	});
});
