import { describe, expect, test } from "bun:test";
import {
	BANNER_MAX_WIDTH,
	BUNDLED_GIF_PATH,
	clamp,
	DEFAULTS,
	defaultGifPath,
	describeConfig,
	expandHome,
	formatSize,
	LIMITS,
	loadConfig,
	parseBool,
	parseBoolDefault,
	parseRenderer,
	parseKittyMode,
	paletteOf,
	parseSize,
	piAgentDir,
} from "../src/config.ts";
import { homedir } from "node:os";
import { join } from "node:path";

describe("clamp", () => {
	test("bounds values", () => {
		expect(clamp(0, 1, 10)).toBe(1);
		expect(clamp(99, 1, 10)).toBe(10);
		expect(clamp(5, 1, 10)).toBe(5);
	});
});

describe("parseSize", () => {
	test("parses WxH with x, X or *", () => {
		expect(parseSize("44x22")).toEqual({ width: 44, height: 22 });
		expect(parseSize("40X20")).toEqual({ width: 40, height: 20 });
		expect(parseSize(" 30*10 ")).toEqual({ width: 30, height: 10 });
	});

	test("clamps into the supported range", () => {
		expect(parseSize("1x1")).toEqual({ width: LIMITS.width.min, height: LIMITS.height.min });
		expect(parseSize("999x999")).toEqual({ width: LIMITS.width.max, height: LIMITS.height.max });
	});

	test("falls back on garbage", () => {
		expect(parseSize(undefined)).toEqual(DEFAULTS.size);
		expect(parseSize("")).toEqual(DEFAULTS.size);
		expect(parseSize("wide")).toEqual(DEFAULTS.size);
		expect(parseSize("44")).toEqual(DEFAULTS.size);
	});
});

describe("parseBool / parseRenderer", () => {
	test("understands the usual truthy spellings", () => {
		for (const value of ["1", "true", "yes", "on", "TRUE"]) expect(parseBool(value)).toBe(true);
		for (const value of ["0", "false", "no", "off", "", undefined]) expect(parseBool(value)).toBe(false);
	});

	test("parseBoolDefault keeps the fallback when the variable is unset", () => {
		expect(parseBoolDefault(undefined, true)).toBe(true);
		expect(parseBoolDefault("", false)).toBe(false);
		expect(parseBoolDefault("   ", true)).toBe(true);
		expect(parseBoolDefault("0", true)).toBe(false);
		expect(parseBoolDefault("1", false)).toBe(true);
	});

	test("rejects unknown renderers", () => {
		expect(parseRenderer("kitty")).toBe("kitty");
		expect(parseRenderer("chars")).toBe("chars");
		expect(parseRenderer("auto")).toBe("auto");
		expect(parseRenderer("sixel")).toBe("auto");
		expect(parseRenderer(undefined)).toBe("auto");
	});
});

describe("expandHome / piAgentDir", () => {
	test("expands a leading tilde", () => {
		expect(expandHome("~/x")).toBe(`${homedir()}/x`);
		expect(expandHome("/abs/x")).toBe("/abs/x");
	});

	test("honours PI_CODING_AGENT_DIR", () => {
		expect(piAgentDir({ PI_CODING_AGENT_DIR: "/tmp/pi-agent" })).toBe("/tmp/pi-agent");
		expect(piAgentDir({})).toBe(`${homedir()}/.pi/agent`);
	});
});

describe("loadConfig", () => {
	test("applies defaults", () => {
		const config = loadConfig({ PI_CODING_AGENT_DIR: "/tmp/pi-agent" });
		expect(config.size).toEqual(DEFAULTS.size);
		expect(config.fps).toBe(DEFAULTS.fps);
		expect(config.stride).toBe(DEFAULTS.stride);
		expect(config.renderer).toBe("auto");
		expect(config.static).toBe(false);
		expect(config.enabled).toBe(true);
		expect(config.hideResources).toBe(true);
	});

	test("reads every PI_BANNER_* variable", () => {
		const config = loadConfig({
			PI_CODING_AGENT_DIR: "/tmp/pi-agent",
			PI_BANNER_FPS: "24",
			PI_BANNER_STRIDE: "5",
			PI_BANNER_SIZE: "60x30",
			PI_BANNER_RENDERER: "kitty",
			PI_BANNER_STATIC: "1",
			PI_BANNER_DISABLED: "1",
			PI_BANNER_GIF: "/tmp/demo.gif",
		});
		expect(config.fps).toBe(24);
		expect(config.stride).toBe(5);
		expect(config.size).toEqual({ width: 60, height: 30 });
		expect(config.renderer).toBe("kitty");
		expect(config.static).toBe(true);
		expect(config.enabled).toBe(false);
		expect(config.gifPath).toBe("/tmp/demo.gif");
	});

	test("clamps fps and stride", () => {
		const slow = loadConfig({ PI_CODING_AGENT_DIR: "/tmp/pi-agent", PI_BANNER_FPS: "0", PI_BANNER_STRIDE: "0" });
		expect(slow.fps).toBe(LIMITS.fps.min);
		expect(slow.stride).toBe(LIMITS.stride.min);
		const fast = loadConfig({ PI_CODING_AGENT_DIR: "/tmp/pi-agent", PI_BANNER_FPS: "999", PI_BANNER_STRIDE: "99" });
		expect(fast.fps).toBe(LIMITS.fps.max);
		expect(fast.stride).toBe(LIMITS.stride.max);
	});

	test("hides pi's resource listing by default, opt out on request", () => {
		const base = { PI_CODING_AGENT_DIR: "/tmp/pi-agent" };
		expect(loadConfig(base).hideResources).toBe(true);
		expect(loadConfig({ ...base, PI_BANNER_HIDE_RESOURCES: "" }).hideResources).toBe(true);
		expect(loadConfig({ ...base, PI_BANNER_HIDE_RESOURCES: "   " }).hideResources).toBe(true);
		for (const value of ["1", "true", "yes", "on", "ON"]) {
			expect(loadConfig({ ...base, PI_BANNER_HIDE_RESOURCES: value }).hideResources).toBe(true);
		}
		for (const value of ["0", "false", "no", "off", "OFF"]) {
			expect(loadConfig({ ...base, PI_BANNER_HIDE_RESOURCES: value }).hideResources).toBe(false);
		}
	});
});

describe("defaultGifPath", () => {
	test("prefers the bundled artwork over every home-directory location", () => {
		// The repo ships assets/banner.gif precisely so a fresh clone renders with
		// no setup; an unrelated ~/Pictures/logo/v-1.gif must not win over it.
		expect(defaultGifPath({}, BUNDLED_GIF_PATH)).toBe(BUNDLED_GIF_PATH);
	});

	test("explicit PI_BANNER_GIF always wins, resolved against cwd", () => {
		expect(defaultGifPath({ PI_BANNER_GIF: "/tmp/demo.gif" }, BUNDLED_GIF_PATH)).toBe("/tmp/demo.gif");
		const relative = defaultGifPath({ PI_BANNER_GIF: "art/x.gif" }, BUNDLED_GIF_PATH);
		expect(relative).toBe(join(process.cwd(), "art/x.gif"));
	});

	test("falls back to a home-directory copy when the bundled gif is absent", () => {
		const resolved = defaultGifPath({ PI_CODING_AGENT_DIR: "/tmp/pi-agent-empty" }, "/nonexistent/banner.gif");
		// Drop-in first, then the machine's original artwork; never the missing bundle.
		expect([
			join("/tmp/pi-agent-empty", "banner.gif"),
			join(homedir(), "Pictures", "logo", "v-1.gif"),
		]).toContain(resolved ?? "");
	});
});

describe("formatSize / describeConfig", () => {
	test("round-trips through parseSize", () => {
		expect(formatSize({ width: 44, height: 22 })).toBe("44x22");
		expect(parseSize(formatSize({ width: 12, height: 6 }))).toEqual({ width: 12, height: 6 });
	});

	test("describes the effective config on one line", () => {
		const text = describeConfig(loadConfig({ PI_CODING_AGENT_DIR: "/tmp/pi-agent", PI_BANNER_SIZE: "40x20" }));
		expect(text).toContain("size=40x20");
		expect(text).toContain("renderer=auto");
	});

	test("max banner width is a sane constant", () => {
		expect(BANNER_MAX_WIDTH).toBeGreaterThanOrEqual(80);
	});
});

describe("kitty config knobs", () => {
	test("parseKittyMode defaults to anim and only accepts frames", () => {
		expect(parseKittyMode("frames")).toBe("frames");
		expect(parseKittyMode("FRAMES")).toBe("frames");
		expect(parseKittyMode("anim")).toBe("anim");
		expect(parseKittyMode("ANIM")).toBe("anim");
		expect(parseKittyMode(undefined)).toBe("anim");
		expect(parseKittyMode("garbage")).toBe("anim");
	});

	test("paletteOf rounds down to a supported palette size", () => {
		expect(paletteOf(100)).toBe(64);
		expect(paletteOf(300)).toBe(256);
		expect(paletteOf(8)).toBe(16);
		expect(paletteOf(128)).toBe(128);
	});

	test("reads the image env vars and clamps them", () => {
		const config = loadConfig({
			PI_CODING_AGENT_DIR: "/tmp/pi-agent",
			PI_BANNER_KITTY_MODE: "frames",
			PI_BANNER_PALETTE: "200",
			PI_BANNER_MAX_PX: "1",
			PI_BANNER_MAX_FRAMES: "900",
			PI_BANNER_ANIM_SECONDS: "5",
		});
		expect(config.kittyMode).toBe("frames");
		// Normalized on read, so the pipeline never sees an unsupported depth.
		expect(config.palette).toBe(128);
		expect(loadConfig({ PI_CODING_AGENT_DIR: "/tmp/pi-agent", PI_BANNER_PALETTE: "64" }).palette).toBe(64);
		expect(loadConfig({ PI_CODING_AGENT_DIR: "/tmp/pi-agent", PI_BANNER_PALETTE: "8" }).palette).toBe(16);
		expect(config.maxPixels).toBe(LIMITS.maxPixels.min);
		expect(config.maxFrames).toBe(LIMITS.maxFrames.max);
		expect(config.animSeconds).toBe(5);
	});

	test("describeConfig mentions the kitty knobs", () => {
		const text = describeConfig(loadConfig({ PI_CODING_AGENT_DIR: "/tmp/pi-agent" }));
		expect(text).toContain("kitty=anim");
		expect(text).toContain("palette=128");
	});
});
