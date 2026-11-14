import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { BUNDLED_GIF_PATH, DEFAULTS, type BannerConfig } from "../src/config.ts";
import {
	cacheRoot,
	chafaColorArgs,
	clearCache,
	FrameError,
	frameCachePath,
	gifHash,
	loadFrames,
	normalizeColorMode,
	preflight,
	sanitizeFrame,
	stripChafaControl,
} from "../src/frames.ts";
import { visibleWidth } from "../src/text.ts";

const ESC = "\x1b";

describe("stripChafaControl", () => {
	test("removes cursor-hide, alt-screen and clear codes", () => {
		const raw = `${ESC}[?25l${ESC}[2J${ESC}[0Hhello${ESC}[?25h`;
		expect(stripChafaControl(raw)).toBe("hello");
	});

	test("keeps SGR color sequences", () => {
		const raw = `${ESC}[?25l${ESC}[38;2;1;2;3m▀${ESC}[39m`;
		expect(stripChafaControl(raw)).toBe(`${ESC}[38;2;1;2;3m▀${ESC}[39m`);
	});

	test("drops carriage returns", () => {
		expect(stripChafaControl("a\r\nb")).toBe("a\nb");
	});
});

describe("sanitizeFrame", () => {
	test("pads and truncates to exactly width x height", () => {
		const frame = sanitizeFrame("aa\nbbbb\n", 3, 4);
		expect(frame.length).toBe(4);
		expect(frame.map((line) => visibleWidth(line))).toEqual([3, 3, 3, 3]);
		expect(frame[1]).toBe("bbb");
	});

	test("keeps colors while padding", () => {
		const frame = sanitizeFrame(`${ESC}[38;2;9;9;9m▀${ESC}[39m`, 4, 1);
		expect(visibleWidth(frame[0]!)).toBe(4);
		expect(frame[0]!.startsWith(`${ESC}[38;2;9;9;9m▀`)).toBe(true);
	});
});

describe("color mode mapping", () => {
	test("normalizes unknown modes to none", () => {
		expect(normalizeColorMode("truecolor")).toBe("truecolor");
		expect(normalizeColorMode("256color")).toBe("256color");
		expect(normalizeColorMode("ansi")).toBe("ansi");
		expect(normalizeColorMode("bogus")).toBe("none");
	});

	test("maps color modes to chafa flags", () => {
		expect(chafaColorArgs("truecolor")).toEqual(["-c", "full"]);
		expect(chafaColorArgs("256color")).toEqual(["-c", "256"]);
		expect(chafaColorArgs("ansi")).toEqual(["-c", "16"]);
		expect(chafaColorArgs("none")).toEqual(["-c", "none"]);
	});
});

describe("gifHash", () => {
	test("rejects missing files", async () => {
		await expect(gifHash("/nonexistent/x.gif")).rejects.toBeInstanceOf(FrameError);
	});

	test("is stable for the same file", async () => {
		const gif = BUNDLED_GIF_PATH;
		if (!existsSync(gif)) return;
		const first = await gifHash(gif);
		const second = await gifHash(gif);
		expect(first).toBe(second);
		expect(first).toMatch(/^[0-9a-f]{40}$/);
	});
});

describe("cache paths", () => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	afterAll(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
	});

	test("live under <agent dir>/tmp/pi-chafa-banner", () => {
		process.env.PI_CODING_AGENT_DIR = "/tmp/pi-chafa-test-agent";
		expect(cacheRoot()).toBe("/tmp/pi-chafa-test-agent/tmp/pi-chafa-banner");
	});

	test("are keyed by gif hash, size and color mode", async () => {
		const gif = BUNDLED_GIF_PATH;
		if (!existsSync(gif)) return;
		const path = await frameCachePath(gif, { width: 44, height: 22 }, "truecolor");
		expect(path.startsWith("/tmp/pi-chafa-test-agent/tmp/pi-chafa-banner/")).toBe(true);
		expect(path.endsWith("frames-44x22-truecolor.json")).toBe(true);
	});

	test("clearCache is a no-op without a gif", async () => {
		const config: BannerConfig = { ...DEFAULTS, gifPath: undefined, enabled: true, renderer: "auto", static: false };
		expect(await clearCache(config, "truecolor")).toBe(false);
	});
});

const gifPath = BUNDLED_GIF_PATH;
const hasTools = (await preflight()).ok;
const hasGif = existsSync(gifPath);

describe("preflight", () => {
	test("reports the tools it found", async () => {
		const result = await preflight();
		expect(typeof result.ok).toBe("boolean");
		expect(Array.isArray(result.missing)).toBe(true);
		expect(result.ok ? Object.keys(result.versions).sort() : result.missing.length > 0).toBeTruthy();
	});
});

describe("loadFrames", () => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const tempAgentDir = join(tmpdir(), `pi-chafa-banner-test-${process.pid}`);
	afterAll(async () => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		// Explicit path; the directory is ours and created by the cache writer.
		await rm(tempAgentDir, { recursive: true, force: true }).catch(() => undefined);
	});

	test("errors out when no gif is configured", async () => {
		const config: BannerConfig = { ...DEFAULTS, gifPath: undefined, enabled: true, renderer: "auto", static: false };
		await expect(loadFrames(config, "truecolor")).rejects.toBeInstanceOf(FrameError);
	});

	test("errors out on a missing gif", async () => {
		const config: BannerConfig = { ...DEFAULTS, gifPath: "/nonexistent/x.gif", enabled: true, renderer: "auto", static: false };
		await expect(loadFrames(config, "truecolor")).rejects.toMatchObject({ code: "no-gif" });
	});

	test.skipIf(!hasTools || !hasGif)("renders real frames and caches them", async () => {
		process.env.PI_CODING_AGENT_DIR = tempAgentDir;
		const config: BannerConfig = {
			...DEFAULTS,
			gifPath,
			// Tiny + huge stride keeps the test at ~2 chafa invocations.
			size: { width: 16, height: 8 },
			stride: 30,
			enabled: true,
			renderer: "auto",
			static: false,
		};

		const first = await loadFrames(config, "truecolor", { force: true });
		expect(first.fromCache).toBe(false);
		expect(first.width).toBe(16);
		expect(first.height).toBe(8);
		expect(first.frames.length).toBeGreaterThan(0);
		expect(first.frames.length).toBeLessThanOrEqual(Math.ceil(first.totalFrames / 30) + 1);
		for (const frame of first.frames) {
			expect(frame.length).toBe(8);
			for (const line of frame) expect(visibleWidth(line) <= 16).toBe(true);
		}

		const second = await loadFrames(config, "truecolor");
		expect(second.fromCache).toBe(true);
		expect(second.frames).toEqual(first.frames);
		expect(second.totalFrames).toBe(first.totalFrames);

		expect(await clearCache(config, "truecolor")).toBe(true);
		const third = await loadFrames(config, "truecolor", { force: true });
		expect(third.fromCache).toBe(false);
	}, 120_000);
});
