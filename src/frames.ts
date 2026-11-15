/**
 * Frame pipeline: gif -> pngs (ffmpeg) -> ANSI art (chafa) -> disk cache.
 *
 * Everything here is async and failure-tolerant: the splash is decoration, so a
 * missing binary, a broken gif or an unwritable cache must degrade to a notice,
 * never block pi's startup or throw out of an event handler.
 *
 * chafa flags and why (verified against chafa 1.18.3):
 *   -f symbols          text output the TUI can render line-by-line
 *   --symbols solid     foreground-only block glyphs: no background colors, so
 *                       the art aligns in any terminal and survives being placed
 *                       next to our own themed panels
 *   --probe off         REQUIRED: without it chafa waits up to 5s for a terminal
 *                       device-attributes reply and can eat stdin
 *   --animate off       one still per file; we drive the animation ourselves
 *   -c full | 256       match the theme's color mode (truecolor vs 256)
 *   -s WxH              fixed cell grid; keeps every frame identical in size
 */

import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { formatSize, type BannerConfig, type BannerSize } from "./config.ts";
import { cacheFilePath, cacheRoot, deleteCacheFile, readCacheJson, writeCacheJson } from "./pipeline/cache.ts";
import { FrameError, gifHash, missingToolsFor, preflight, run } from "./pipeline/process.ts";
import { aggregateDelays, probeGifTiming, sampledIndices } from "./pipeline/timing.ts";
import { padVisible, truncateToWidth, visibleWidth } from "./text.ts";

// Re-exported so callers keep one import for "the char pipeline".
export { FrameError, gifHash, missingToolsFor, preflight, run } from "./pipeline/process.ts";
export { cacheRoot } from "./pipeline/cache.ts";
export type { PreflightResult } from "./pipeline/process.ts";

export interface FrameSet {
	frames: string[][];
	width: number;
	height: number;
	colorMode: string;
	gifPath: string;
	totalFrames: number;
	stride: number;
	/** How long each *stored* frame stays on screen, in milliseconds. */
	delays: number[];
	fromCache: boolean;
	builtAt: number;
}

export const CACHE_VERSION = 2;
export const MAX_GIF_FRAMES = 240;

export function normalizeColorMode(mode: string): "truecolor" | "256color" | "ansi" | "none" {
	if (mode === "truecolor" || mode === "256color" || mode === "ansi") return mode;
	return "none";
}

export function chafaColorArgs(mode: string): string[] {
	switch (normalizeColorMode(mode)) {
		case "truecolor":
			return ["-c", "full"];
		case "256color":
			return ["-c", "256"];
		case "ansi":
			return ["-c", "16"];
		default:
			return ["-c", "none"];
	}
}

export async function frameCachePath(gifPath: string, size: BannerSize, colorMode: string): Promise<string> {
	const hash = await gifHash(gifPath);
	return cacheFilePath(hash, `frames-${formatSize(size)}-${normalizeColorMode(colorMode)}.json`);
}

/** Delete exactly this gif's char-frame cache (never a directory tree). */
export async function clearCache(config: BannerConfig, colorMode: string): Promise<boolean> {
	if (!config.gifPath) return false;
	try {
		return await deleteCacheFile(await frameCachePath(config.gifPath, config.size, colorMode));
	} catch {
		return false;
	}
}

interface CachePayload {
	version: number;
	width: number;
	height: number;
	colorMode: string;
	gifPath: string;
	totalFrames: number;
	stride: number;
	/** Per-frame display time in ms; missing in caches written before v2. */
	delays?: number[];
	builtAt: number;
	frames: string[][];
}

function isFrameSetLike(value: unknown): value is CachePayload {
	if (!value || typeof value !== "object") return false;
	const v = value as Partial<CachePayload>;
	return (
		v.version === CACHE_VERSION &&
		typeof v.width === "number" &&
		typeof v.height === "number" &&
		typeof v.colorMode === "string" &&
		Array.isArray(v.frames) &&
		v.frames.length > 0 &&
		v.frames.every((frame) => Array.isArray(frame) && frame.every((line) => typeof line === "string")) &&
		(v.delays === undefined || (Array.isArray(v.delays) && v.delays.every((value) => typeof value === "number")))
	);
}

async function readCache(
	path: string,
	size: BannerSize,
	colorMode: string,
): Promise<CachePayload | undefined> {
	const parsed = await readCacheJson(path);
	if (!isFrameSetLike(parsed)) return undefined;
	if (parsed.width !== size.width || parsed.height !== size.height) return undefined;
	if (normalizeColorMode(parsed.colorMode) !== normalizeColorMode(colorMode)) return undefined;
	return parsed;
}

// ---------------------------------------------------------------------------
// chafa output cleaning
// ---------------------------------------------------------------------------

/**
 * chafa wraps its output in cursor-hide + clear codes so it can repaint a
 * terminal. Inside a pi header those would fight the TUI's renderer, so strip
 * them — but keep SGR (`\x1b[...m`), which is the image itself.
 */
export function stripChafaControl(raw: string): string {
	return raw
		.replace(/\x1b\[\?25[lh]/g, "")
		.replace(/\x1b\[\?1049[lh]/g, "")
		.replace(/\x1b\[(?:2J|3J|0?H|\d+;\d+H)/g, "")
		.replace(/\r/g, "");
}

/** Split chafa output into exactly `height` lines of exactly `width` columns. */
export function sanitizeFrame(raw: string, width: number, height: number): string[] {
	const cleaned = stripChafaControl(raw);
	const rawLines = cleaned.split("\n");
	while (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") rawLines.pop();
	const lines: string[] = [];
	for (let row = 0; row < height; row++) {
		const line = rawLines[row] ?? "";
		lines.push(padVisible(truncateToWidth(line, width, ""), width));
	}
	return lines;
}

// ---------------------------------------------------------------------------
// pipeline
// ---------------------------------------------------------------------------

/**
 * `-vsync 0` was the long-standing way to say "one output file per input frame".
 * ffmpeg 8 removed the flag in favour of `-fps_mode passthrough`, while older
 * builds do not know `-fps_mode`, so try the new spelling first and fall back.
 * The flag must come *after* `-i` (it is an output option).
 */
export async function extractFrames(gifPath: string, pattern: string, timeoutMs: number): Promise<void> {
	const variants: string[][] = [["-fps_mode", "passthrough"], ["-vsync", "0"], []];
	let lastError: unknown;
	for (const variant of variants) {
		try {
			await run("ffmpeg", ["-y", "-loglevel", "error", "-i", gifPath, ...variant, pattern], timeoutMs);
			return;
		} catch (error) {
			lastError = error;
			// A missing/unreadable input fails identically for every variant;
			// only retry when ffmpeg rejected the option itself.
			if (!/Unrecognized option|Option not found|Invalid argument|Error parsing options/i.test(String(error))) break;
		}
	}
	throw new FrameError("ffmpeg", `ffmpeg could not read ${gifPath}: ${(lastError as Error)?.message ?? lastError}`);
}

export interface LoadFramesOptions {
	/** Skip the disk cache (used by `/splash rebuild`). */
	force?: boolean;
	timeoutMs?: number;
}

export async function loadFrames(
	config: BannerConfig,
	colorMode: string,
	options: LoadFramesOptions = {},
): Promise<FrameSet> {
	const gifPath = config.gifPath;
	if (!gifPath) {
		throw new FrameError("no-gif", "no gif configured (set PI_BANNER_GIF)");
	}

	const tools = await preflight();
	if (!tools.ok) {
		throw new FrameError("missing-tool", `missing ${tools.missing.join(", ")} on PATH`);
	}

	const size = config.size;
	const cachePath = await frameCachePath(gifPath, size, colorMode);

	if (!options.force) {
		const cached = await readCache(cachePath, size, colorMode);
		if (cached) {
			return {
				frames: cached.frames,
				width: cached.width,
				height: cached.height,
				colorMode: normalizeColorMode(colorMode),
				gifPath,
				totalFrames: cached.totalFrames,
				stride: cached.stride,
				delays: cached.delays ?? cached.frames.map(() => 100),
				fromCache: true,
				builtAt: cached.builtAt,
			};
		}
	}

	const timeoutMs = options.timeoutMs ?? 20_000;
	// Scratch space lives inside this gif's cache directory (invariant 8: writes
	// only under ~/.pi/agent/tmp/pi-chafa-banner/<sha1>/), not in the system temp
	// dir, so a killed process never litters /tmp with PNG frames.
	const workRoot = dirname(cachePath);
	await mkdir(workRoot, { recursive: true });
	const workDir = await mkdtemp(join(workRoot, "work-"));
	try {
		const pattern = join(workDir, "f%03d.png");
		await extractFrames(gifPath, pattern, Math.max(timeoutMs, 60_000));

		const files = (await readdir(workDir))
			.filter((name) => /^f\d+\.png$/.test(name))
			.sort((a, b) => a.localeCompare(b))
			.slice(0, MAX_GIF_FRAMES);
		if (files.length === 0) {
			throw new FrameError("ffmpeg", `no frames extracted from ${gifPath}`);
		}

		const stride = Math.max(1, config.stride);
		// Timing first: every sampled frame inherits the delays of the frames it
		// replaced, so one loop keeps the gif's real length at any stride.
		const timing = await probeGifTiming(gifPath);
		const sampled = sampledIndices(files.length, stride);
		const sampledDelays = aggregateDelays(timing.delays, sampled);
		const frames: string[][] = [];
		const delays: number[] = [];
		let carried = 0;
		for (let slot = 0; slot < sampled.length; slot++) {
			const file = files[sampled[slot] as number];
			if (!file) continue;
			const { stdout } = await run(
				"chafa",
				[
					"-f",
					"symbols",
					"--symbols",
					"solid",
					"--probe",
					"off",
					...chafaColorArgs(colorMode),
					"-s",
					formatSize(size),
					"--animate",
					"off",
					join(workDir, file),
				],
				timeoutMs,
			);
			const frame = sanitizeFrame(stdout, size.width, size.height);
			if (!frame.some((line) => visibleWidth(line) > 0)) {
				// Blank frame: fold its screen time into the next visible one.
				carried += sampledDelays[slot] ?? 100;
				continue;
			}
			frames.push(frame);
			delays.push((sampledDelays[slot] ?? 100) + carried);
			carried = 0;
		}
		if (frames.length === 0) {
			throw new FrameError("chafa", "chafa produced no renderable frames");
		}
		if (carried > 0 && delays.length > 0) {
			delays[delays.length - 1] = (delays[delays.length - 1] ?? 100) + carried;
		}

		const builtAt = Date.now();
		const payload: CachePayload = {
			version: CACHE_VERSION,
			width: size.width,
			height: size.height,
			colorMode: normalizeColorMode(colorMode),
			gifPath,
			totalFrames: files.length,
			stride,
			delays,
			builtAt,
			frames,
		};
		await writeCacheJson(cachePath, payload);

		return {
			frames,
			width: size.width,
			height: size.height,
			colorMode: normalizeColorMode(colorMode),
			gifPath,
			totalFrames: files.length,
			stride,
			delays,
			fromCache: false,
			builtAt,
		};
	} finally {
		// Explicit path from mkdtemp; never a wildcard.
		await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
	}
}
