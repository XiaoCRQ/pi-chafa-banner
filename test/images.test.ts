import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, type BannerConfig } from "../src/config.ts";
import { FrameError, preflight } from "../src/frames.ts";
import {
	clearImageCache,
	decimate,
	imageCachePath,
	loadImageFrames,
	pngDimensions,
	readPngBase64,
} from "../src/images.ts";

const ASSET = join(import.meta.dir, "..", "assets", "banner.gif");
const realPath = process.env.PATH ?? "";
let agentDir = "";

const config: BannerConfig = {
	...DEFAULTS,
	gifPath: ASSET,
	enabled: true,
	fps: 30,
	stride: 3,
	static: false,
	maxFrames: 24,
};

/** Tiny grid keeps the ffmpeg passes fast; the shape logic is unaffected. */
const budget = { maxColumns: 8, maxRows: 4 };

beforeAll(async () => {
	agentDir = await mkdtemp(join(tmpdir(), "pi-chafa-images-test-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
	process.env.PATH = realPath;
});

/** A bin dir holding only an `ffmpeg` that reports a version for preflight. */
async function fakeFfmpegBin(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-chafa-bin-"));
	const script = [
		"#!/bin/sh",
		'if [ "$1" = "-version" ]; then echo "ffmpeg version test-shim"; exit 0; fi',
		'echo "shim: refusing to encode" >&2',
		"exit 1",
		"",
	].join("\n");
	const path = join(dir, "ffmpeg");
	await writeFile(path, script, "utf8");
	await chmod(path, 0o755);
	return dir;
}

/** Absolute path of a binary on the real PATH. */
function realWhich(bin: string): string {
	return execSync(`command -v ${bin}`, { encoding: "utf8", env: { ...process.env, PATH: realPath } }).trim();
}

/** A bin dir with nothing in it (preflight finds neither tool). */
async function emptyBin(): Promise<string> {
	return mkdtemp(join(tmpdir(), "pi-chafa-empty-"));
}

describe("images: cache path", () => {
	test("sits next to, but never on top of, the chafa frame cache", async () => {
		const path = imageCachePath("deadbeef", budget, { widthPx: 9, heightPx: 18 }, 128, 3);
		expect(path.startsWith(join(agentDir, "tmp", "pi-chafa-banner", "deadbeef"))).toBe(true);
		expect(path).toContain("images-b8x4-c9x18-p128-s3.json");
		expect(path).not.toContain("frames-");
	});

	test("cell size and palette are part of the key", async () => {
		const a = imageCachePath("h", budget, { widthPx: 9, heightPx: 18 }, 64, 3);
		const b = imageCachePath("h", budget, { widthPx: 18, heightPx: 36 }, 64, 3);
		const c = imageCachePath("h", budget, { widthPx: 9, heightPx: 18 }, 256, 3);
		expect(a).not.toBe(b);
		expect(a).not.toBe(c);
	});
});

describe("images: failure modes", () => {
	test("no configured gif is a FrameError, not a crash", async () => {
		await expect(loadImageFrames({ ...config, gifPath: undefined })).rejects.toBeInstanceOf(FrameError);
	});

	test("a missing gif reports no-gif", async () => {
		const error = await loadImageFrames({ ...config, gifPath: "/nonexistent/pi-chafa.gif" }).catch((e) => e);
		expect(error).toBeInstanceOf(FrameError);
		expect((error as FrameError).code).toBe("no-gif");
	});

	test("a missing ffmpeg reports missing-tool", async () => {
		process.env.PATH = await emptyBin();
		await preflight(true);
		const error = await loadImageFrames(config, budget).catch((e) => e);
		expect((error as FrameError).code).toBe("missing-tool");
		expect(String((error as FrameError).message)).toContain("ffmpeg");
	});
});

describe("images: pipeline", () => {
	test("only ffmpeg is required — no chafa on PATH still works", async () => {
		// A bin dir with a real ffmpeg symlink and nothing else.
		const dir = await mkdtemp(join(tmpdir(), "pi-chafa-noshafa-"));
		await symlink(realWhich("ffmpeg"), join(dir, "ffmpeg"));
		process.env.PATH = dir;
		const tools = await preflight(true);
		expect(tools.missing).toContain("chafa");
		expect(tools.missing).not.toContain("ffmpeg");
		const built = await loadImageFrames({ ...config, stride: 30 }, { ...budget, force: true });
		expect(built.frames.length).toBeGreaterThan(0);
		expect(built.columns).toBe(8);
	});

	test("builds frames, then serves them from cache without touching ffmpeg", async () => {
		process.env.PATH = realPath;
		await preflight(true);
		const tmpBefore = new Set(await readdir(tmpdir()));
		const built = await loadImageFrames(config, { ...budget, force: true });
		expect(built.fromCache).toBe(false);
		expect(built.protocol).toBe("kitty");
		expect(built.frames.length).toBeGreaterThan(0);
		expect(built.frames.length).toBeLessThanOrEqual(config.maxFrames);
		expect(built.columns).toBe(8);
		expect(built.rows).toBe(4);
		expect(built.pixelWidth).toBe(8 * 9);
		expect(built.pixelHeight).toBe(4 * 18);

		// Invariant 8: the PNG scratch dir lives under the cache dir, and it is gone
		// once the build finishes — nothing new shows up in the system temp dir.
		const added = (await readdir(tmpdir())).filter((name) => !tmpBefore.has(name));
		expect(added.filter((name) => name.startsWith("pi-chafa-images-"))).toEqual([]);
		const staging = join(agentDir, "tmp", "pi-chafa-banner");
		if (existsSync(staging)) {
			const leftovers = (await readdir(staging)).filter((name) => name.startsWith("work-"));
			expect(leftovers).toEqual([]);
		}

		// From here on ffmpeg cannot run at all: a cache hit must still succeed.
		process.env.PATH = await fakeFfmpegBin();
		await preflight(true);
		const cached = await loadImageFrames(config, budget);
		expect(cached.fromCache).toBe(true);
		expect(cached.frames.length).toBe(built.frames.length);
		expect(cached.columns).toBe(built.columns);
		expect(cached.sequence).toContain(`i=${cached.imageId}`);
	});

	test("every load allocates a fresh image id", async () => {
		const a = await loadImageFrames(config, budget);
		const b = await loadImageFrames(config, budget);
		expect(a.imageId).not.toBe(b.imageId);
		expect(a.sequence).toContain(`i=${a.imageId}`);
		expect(b.sequence).toContain(`i=${b.imageId}`);
	});

	test("a stale cache version is treated as a miss and overwritten", async () => {
		process.env.PATH = realPath;
		await preflight(true);
		await loadImageFrames(config, budget);
		const cachePath = imageCachePath(await gifHashOf(ASSET), budget, await cellOf(), config.palette, config.stride);
		expect(existsSync(cachePath)).toBe(true);
		await writeFile(cachePath, JSON.stringify({ version: 999, protocol: "kitty", frames: ["x"] }), "utf8");
		const rebuilt = await loadImageFrames(config, budget);
		expect(rebuilt.fromCache).toBe(false);
		expect(rebuilt.frames.length).toBeGreaterThan(1);
	});

	test("clearImageCache removes exactly one file", async () => {
		process.env.PATH = realPath;
		await preflight(true);
		await loadImageFrames(config, budget);
		expect(await clearImageCache(config, budget)).toBe(true);
		expect(await clearImageCache(config, budget)).toBe(true);
	});
});

async function gifHashOf(path: string): Promise<string> {
	const { gifHash } = await import("../src/frames.ts");
	return gifHash(path);
}

async function cellOf(): Promise<{ widthPx: number; heightPx: number }> {
	const { kittyCellDimensions } = await import("../src/kitty.ts");
	return kittyCellDimensions();
}

describe("images: helpers", () => {
	test("decimate keeps the first frame and an even spread", () => {
		const items = Array.from({ length: 57 }, (_, index) => index + 1);
		const picked = decimate(items, 24);
		expect(picked.length).toBe(24);
		expect(picked[0]).toBe(1);
		expect(picked[picked.length - 1]).toBe(57);
		expect(decimate([1, 2, 3], 10)).toEqual([1, 2, 3]);
		expect(decimate([1, 2, 3], 1)).toEqual([1]);
	});

	test("pngDimensions reads a real PNG and rejects other bytes", async () => {
		const files = await mkdtemp(join(tmpdir(), "pi-chafa-png-"));
		const { run } = await import("../src/frames.ts");
		await run("ffmpeg", ["-y", "-loglevel", "error", "-i", ASSET, "-frames:v", "1", join(files, "p.png")]);
		const bytes = await readFile(join(files, "p.png"));
		const size = pngDimensions(bytes);
		expect(size).toBeDefined();
		expect(size!.width).toBeGreaterThan(0);
		expect(size!.height).toBe(size!.width);
		expect(pngDimensions(new Uint8Array([1, 2, 3]))).toBeUndefined();
		expect(pngDimensions(Buffer.from("not a png at all, definitely not"))).toBeUndefined();
	});

	test("readPngBase64 returns base64 without a data: prefix", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-chafa-b64-"));
		const file = join(dir, "a.png");
		await writeFile(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]));
		const frames = await readPngBase64([file]);
		expect(frames[0]!.base64).toBe(Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]).toString("base64"));
		expect(frames[0]!.base64.startsWith("data:")).toBe(false);
	});
});
