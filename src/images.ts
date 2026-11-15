/**
 * Native image pipeline: gif -> quantized PNG frames -> kitty root frame.
 *
 * Mirrors the chafa pipeline in `frames.ts` but stops at PNG: the terminal
 * decodes the pixels, we only reserve cells and hand pi a single string.
 *
 * Cache layout is deliberately separate from `frames-*.json`:
 *   <cacheRoot>/<gifSha1>/images-b<cols>x<rows>-c<cellW>x<cellH>-p<palette>-s<stride>.json
 *
 * The kitty *image id* is never persisted — it is allocated per load so two pi
 * processes sharing a cache directory cannot collide in the terminal.
 */

import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { paletteOf, type BannerConfig } from "./config.ts";
import { cacheFilePath, cacheRoot, deleteCacheFile, readCacheJson, writeCacheJson } from "./pipeline/cache.ts";
import { FrameError, gifHash, missingToolsFor, preflight, run } from "./pipeline/process.ts";
import { extractFrames } from "./frames.ts";
import { aggregateDelays, probeGifTiming, sampledIndices, thinDelays } from "./pipeline/timing.ts";
import {
	allocateImageId,
	calculateImageCells,
	encodeKittyStub,
	kittyCellDimensions,
	renderKittyRoot,
} from "./kitty.ts";
import type { CellDimensions, ImageDimensions } from "@earendil-works/pi-tui";

/** One frame of a kitty animation. */
export interface ImageFrame {
	/** base64 PNG bytes, without a `data:` prefix. */
	base64: string;
}

/** A fully prepared image, ready for `Banner.render`. */
export interface ImageFrameSet {
	protocol: "kitty";
	/** `frames[0]` is both the root frame and the only frame in static mode. */
	frames: ImageFrame[];
	/** Character-grid columns reported by `renderImage`. */
	columns: number;
	/** Character-grid rows reported by `renderImage` — drives the reserved rows. */
	rows: number;
	pixelWidth: number;
	pixelHeight: number;
	/** Process-unique kitty image id (never cached). */
	imageId: number;
	/** Root frame transmission (`a=T`, with `c=`/`r=`/`i=`/`C=1`). */
	sequence: string;
	/** Average frame gap in milliseconds (kept for display / fallbacks). */
	gapMs: number;
	/** Per-frame delay in milliseconds; drives the kitty `z=` values. */
	gapsMs: number[];
	gifPath: string;
	totalFrames: number;
	stride: number;
	palette: number;
	fromCache: boolean;
	builtAt: number;
}

/** Bump whenever the JSON shape below changes; independent of `CACHE_VERSION`. */
export const IMAGE_CACHE_VERSION = 2;

/** Hard ceiling on the in-memory base64 payload (all frames combined). */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_IMAGE_TIMEOUT_MS = 20_000;
const MAX_FRAMES_HARD_CAP = 240;

interface ImageCachePayload {
	version: number;
	protocol: "kitty";
	columns: number;
	rows: number;
	pixelWidth: number;
	pixelHeight: number;
	palette: number;
	gifPath: string;
	totalFrames: number;
	stride: number;
	gapMs: number;
	/** Per-frame delays; absent in caches written before v2. */
	gapsMs?: number[];
	builtAt: number;
	frames: string[];
}

export interface ImageLoadOptions {
	/** Grid budget (character cells). Defaults to `config.size`. */
	maxColumns?: number;
	maxRows?: number;
	/** Skip the disk cache (used by `/splash rebuild`). */
	force?: boolean;
	timeoutMs?: number;
	/** Force the local encoder instead of pi-tui's `renderImage` (preview). */
	payloadStub?: boolean;
}

export interface ImageGrid {
	columns: number;
	rows: number;
	pixelWidth: number;
	pixelHeight: number;
}

/**
 * Cache file for one gif + grid + cell size + palette + stride combination.
 * Kept in a sibling name to `frames-*.json` so the two pipelines never
 * overwrite each other.
 */
export function imageCachePath(
	gifSha1: string,
	budget: { maxColumns: number; maxRows: number },
	cell: CellDimensions,
	palette: number,
	stride: number,
): string {
	return cacheFilePath(
		gifSha1,
		`images-b${budget.maxColumns}x${budget.maxRows}-c${cell.widthPx}x${cell.heightPx}-p${palette}-s${stride}.json`,
	);
}

/** Delete exactly one image cache file (never a directory tree). */
export async function clearImageCache(config: BannerConfig, options: ImageLoadOptions = {}): Promise<boolean> {
	if (!config.gifPath) return false;
	try {
		const cell = await kittyCellDimensions();
		const hash = await gifHash(config.gifPath);
		const budget = {
			maxColumns: options.maxColumns ?? config.size.width,
			maxRows: options.maxRows ?? config.size.height,
		};
		return await deleteCacheFile(imageCachePath(hash, budget, cell, paletteOf(config.palette), Math.max(1, config.stride)));
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// png helpers
// ---------------------------------------------------------------------------

/** Read the IHDR chunk: width at byte 16, height at byte 20 (big endian). */
export function pngDimensions(buffer: Uint8Array): { width: number; height: number } | undefined {
	if (buffer.length < 24) return undefined;
	if (buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4e || buffer[3] !== 0x47) return undefined;
	const view = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
	return { width: view.readUInt32BE(16), height: view.readUInt32BE(20) };
}

/**
 * First-frame pixel size of the gif. Needs ffmpeg: gifs can be any size and the
 * cell grid (and therefore the PNG we ask ffmpeg for) depends on it.
 */
export async function probeGifSize(gifPath: string, workDir: string, timeoutMs = MAX_IMAGE_TIMEOUT_MS): Promise<ImageDimensions> {
	const out = join(workDir, "probe.png");
	try {
		await run("ffmpeg", ["-y", "-loglevel", "error", "-i", gifPath, "-frames:v", "1", out], timeoutMs);
	} catch (error) {
		throw new FrameError("image", `ffmpeg could not probe ${gifPath}: ${(error as Error)?.message ?? error}`);
	}
	const bytes = await readFile(out).catch(() => undefined);
	const size = bytes ? pngDimensions(bytes) : undefined;
	if (!size || size.width <= 0 || size.height <= 0) {
		throw new FrameError("image", `could not read PNG dimensions from ${gifPath}`);
	}
	return { widthPx: size.width, heightPx: size.height };
}

/**
 * Aspect ratio of the artwork, for `height: "auto"`.
 *
 * Deliberately renderer-agnostic: chafa's canvas and the native cell grid must
 * agree on the band height, otherwise the two modes produce visibly different
 * splashes. Cheap (one ffmpeg run, no quantization) and only used when the
 * config asks for an automatic height.
 */
export async function probeSourceSize(gifPath: string, timeoutMs = MAX_IMAGE_TIMEOUT_MS): Promise<{ width: number; height: number }> {
	const dir = join(cacheRoot(), "probe");
	await mkdir(dir, { recursive: true });
	const size = await probeGifSize(gifPath, dir, timeoutMs);
	return { width: size.widthPx, height: size.heightPx };
}

/**
 * Evenly thin a list down to `max` entries, always keeping the first one (it is
 * the root frame and the static image).
 */
export function decimate<T>(items: readonly T[], max: number): T[] {
	if (max <= 0) return [];
	if (items.length <= max) return [...items];
	if (max === 1) return [items[0] as T];
	const out: T[] = [];
	for (let index = 0; index < max; index++) {
		out.push(items[Math.floor((index * (items.length - 1)) / (max - 1))] as T);
	}
	return out;
}

/**
 * Human summary of the animation timing, e.g. `300ms ×8 = 2.40s (3.3fps)`.
 * Shown by `/splash status` and `preview`, so a "why is it fast" report can be
 * answered from the tool output alone.
 */
export function describeGap(images: ImageFrameSet): string {
	const gaps = images.gapsMs.length > 0 ? images.gapsMs : [images.gapMs];
	const first = gaps[0] ?? images.gapMs;
	const total = gaps.reduce((sum, value) => sum + value, 0);
	const uniform = gaps.every((value) => Math.abs(value - first) < 1);
	const fps = total > 0 ? gaps.length / (total / 1000) : 0;
	const each = uniform ? `${first}ms` : `${Math.round(total / gaps.length)}ms avg`;
	return `${each} ×${gaps.length} = ${(total / 1000).toFixed(2)}s (${fps.toFixed(1)}fps)`;
}

export async function readPngBase64(paths: readonly string[]): Promise<ImageFrame[]> {
	const frames: ImageFrame[] = [];
	for (const path of paths) {
		const bytes = await readFile(path);
		frames.push({ base64: bytes.toString("base64") });
	}
	return frames;
}

// ---------------------------------------------------------------------------
// encoding
// ---------------------------------------------------------------------------

/** Grid for the terminal, capped by pixel count as well as cells. */
export function planImageGrid(
	image: ImageDimensions,
	cell: CellDimensions,
	budget: { maxColumns: number; maxRows: number },
	maxPixels: number,
): ImageGrid {
	const cells = calculateImageCells(image, cell, budget.maxColumns, budget.maxRows);
	let columns = cells.columns;
	let rows = cells.rows;
	const pixels = () => columns * cell.widthPx * rows * cell.heightPx;
	while (pixels() > maxPixels && (columns > 1 || rows > 1)) {
		columns = Math.max(1, Math.floor(columns * 0.8));
		rows = Math.max(1, Math.floor(rows * 0.8));
	}
	return { columns, rows, pixelWidth: columns * cell.widthPx, pixelHeight: rows * cell.heightPx };
}

function paletteFilter(grid: ImageGrid, palette: number): string {
	return [
		`scale=${grid.pixelWidth}:${grid.pixelHeight}:flags=lanczos`,
		"split[a][b]",
		`[a]palettegen=max_colors=${palette}:stats_mode=full[p]`,
		"[b][p]paletteuse=dither=bayer:bayer_scale=3",
	].join(",");
}

/**
 * One ffmpeg pass: extract, scale and quantize every frame to a PNG of exactly
 * `pixelWidth x pixelHeight`.
 *
 * Fallbacks (each step only on failure): pal8 palette -> rgb24 -> single frame.
 */
async function encodeImagePngs(
	gifPath: string,
	workDir: string,
	grid: ImageGrid,
	palette: number,
	timeoutMs: number,
): Promise<string[]> {
	const pattern = join(workDir, "img%04d.png");
	const passes: { vf?: string; pixFmt: string; frames?: number }[] = [
		{ vf: paletteFilter(grid, palette), pixFmt: "pal8" },
		{ vf: `scale=${grid.pixelWidth}:${grid.pixelHeight}:flags=lanczos`, pixFmt: "rgb24" },
		{ vf: `scale=${grid.pixelWidth}:${grid.pixelHeight}:flags=lanczos`, pixFmt: "rgb24", frames: 1 },
	];
	let lastError: unknown;
	for (const pass of passes) {
		const args = ["-y", "-loglevel", "error", "-i", gifPath, "-frames:v", String(pass.frames ?? MAX_FRAMES_HARD_CAP)];
		if (pass.vf) args.push("-vf", pass.vf);
		args.push("-c:v", "png", "-pix_fmt", pass.pixFmt, pattern);
		try {
			await run("ffmpeg", args, timeoutMs);
			const files = (await readdir(workDir))
				.filter((name) => /^img\d+\.png$/.test(name))
				.sort((a, b) => a.localeCompare(b))
				.slice(0, pass.frames ?? MAX_FRAMES_HARD_CAP);
			if (files.length > 0) return files.map((name) => join(workDir, name));
		} catch (error) {
			lastError = error;
		}
	}
	throw new FrameError("image", `ffmpeg could not encode ${gifPath}: ${(lastError as Error)?.message ?? lastError}`);
}

/** Total base64 characters, the number the memory ceiling is about. */
function payloadBytes(frames: readonly ImageFrame[]): number {
	return frames.reduce((sum, frame) => sum + frame.base64.length, 0);
}

// ---------------------------------------------------------------------------
// cache
// ---------------------------------------------------------------------------

function isImageCachePayload(value: unknown): value is ImageCachePayload {
	if (!value || typeof value !== "object") return false;
	const v = value as Partial<ImageCachePayload>;
	return (
		v.version === IMAGE_CACHE_VERSION &&
		v.protocol === "kitty" &&
		typeof v.columns === "number" &&
		v.columns > 0 &&
		typeof v.rows === "number" &&
		v.rows > 0 &&
		Array.isArray(v.frames) &&
		v.frames.length > 0 &&
		v.frames.every((frame) => typeof frame === "string" && frame.length > 0) &&
		(v.gapsMs === undefined ||
			(Array.isArray(v.gapsMs) && v.gapsMs.every((value) => typeof value === "number" && value > 0)))
	);
}

async function readImageCache(path: string): Promise<ImageCachePayload | undefined> {
	const parsed = await readCacheJson(path);
	return isImageCachePayload(parsed) ? parsed : undefined;
}

async function writeImageCache(path: string, payload: ImageCachePayload): Promise<void> {
	await writeCacheJson(path, payload);
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

/**
 * Load (or build) the kitty image set.
 *
 * Throws `FrameError` on missing tools / gif / encoder failure; callers turn
 * that into a placeholder card plus a one-shot notice.
 */
export async function loadImageFrames(config: BannerConfig, options: ImageLoadOptions = {}): Promise<ImageFrameSet> {
	const gifPath = config.gifPath;
	if (!gifPath) throw new FrameError("no-gif", "no gif configured (set PI_BANNER_GIF)");

	const tools = await preflight();
	const missing = missingToolsFor(tools, "kitty");
	if (missing.length > 0) throw new FrameError("missing-tool", `missing ${missing.join(", ")} on PATH`);

	const cell = await kittyCellDimensions();
	const palette = paletteOf(config.palette);
	const stride = Math.max(1, config.stride);
	const budget = {
		maxColumns: Math.max(1, options.maxColumns ?? config.size.width),
		maxRows: Math.max(1, options.maxRows ?? config.size.height),
	};
	// Timing comes from the gif itself: with `stride > 1` every kept frame has to
	// stand in for the ones we dropped, or the loop plays `stride` times too fast.
	const timing = await probeGifTiming(gifPath);
	const gapMs = Math.max(1, Math.round(timing.totalMs / Math.max(1, timing.delays.length)));
	const hash = await gifHash(gifPath);
	const cachePath = imageCachePath(hash, budget, cell, palette, stride);
	const timeoutMs = options.timeoutMs ?? MAX_IMAGE_TIMEOUT_MS;

	let payload: ImageCachePayload | undefined;
	let fromCache = false;
	if (!options.force) {
		payload = await readImageCache(cachePath);
		fromCache = payload !== undefined;
	}

	if (!payload) {
		// Scratch space inside this gif's cache dir (invariant 8), never /tmp.
		const workRoot = dirname(cachePath);
		await mkdir(workRoot, { recursive: true });
		const workDir = await mkdtemp(join(workRoot, "work-"));
		try {
			const imageDim = await probeGifSize(gifPath, workDir, timeoutMs);
			let grid = planImageGrid(imageDim, cell, budget, config.maxPixels);
			let files = await encodeImagePngs(gifPath, workDir, grid, palette, timeoutMs);
			const totalFrames = files.length;

			const sampled = sampledIndices(totalFrames, stride);
			const sampledFiles = sampled.map((index) => files[index]!).filter((path) => path !== undefined);
			const picked = decimate(sampledFiles, Math.max(1, config.maxFrames));
			let gaps = thinDelays(aggregateDelays(timing.delays, sampled), picked.length);
			let frames = await readPngBase64(picked);

			// Memory ceiling: thin frames first, then shrink the grid once, then
			// settle for a still image.
			if (payloadBytes(frames) > MAX_IMAGE_BYTES) {
				const keep = Math.max(1, Math.floor((frames.length * MAX_IMAGE_BYTES) / payloadBytes(frames)));
				gaps = thinDelays(gaps, Math.min(keep, frames.length));
				frames = decimate(frames, keep);
			}
			if (payloadBytes(frames) > MAX_IMAGE_BYTES) {
				const shrunk = {
					columns: Math.max(1, Math.floor(grid.columns * 0.75)),
					rows: Math.max(1, Math.floor(grid.rows * 0.75)),
					pixelWidth: 0,
					pixelHeight: 0,
				};
				shrunk.pixelWidth = shrunk.columns * cell.widthPx;
				shrunk.pixelHeight = shrunk.rows * cell.heightPx;
				const retryDir = await mkdtemp(join(workRoot, "work-"));
				try {
					const retryFiles = await encodeImagePngs(gifPath, retryDir, shrunk, palette, timeoutMs);
					const retryPicked = decimate(
						retryFiles.filter((_, index) => index % stride === 0),
						Math.max(1, config.maxFrames),
					);
					const retryFrames = await readPngBase64(retryPicked);
					if (retryFrames.length > 0 && payloadBytes(retryFrames) < payloadBytes(frames)) {
						grid = shrunk;
						gaps = thinDelays(gaps, retryFrames.length);
						frames = retryFrames;
					}
				} catch {
					// keep the previous encoding
				} finally {
					await rm(retryDir, { recursive: true, force: true }).catch(() => undefined);
				}
			}
			if (payloadBytes(frames) > MAX_IMAGE_BYTES) {
				gaps = [gaps.reduce((acc, value) => acc + value, 0)];
				frames = [frames[0] as ImageFrame];
			}

			payload = {
				version: IMAGE_CACHE_VERSION,
				protocol: "kitty",
				columns: grid.columns,
				rows: grid.rows,
				pixelWidth: grid.pixelWidth,
				pixelHeight: grid.pixelHeight,
				palette,
				gifPath,
				totalFrames,
				stride,
				gapMs,
				gapsMs: gaps,
				builtAt: Date.now(),
				frames: frames.map((frame) => frame.base64),
			};
			await writeImageCache(cachePath, payload);
		} finally {
			// Explicit mkdtemp path; never a wildcard.
			await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
		}
	}

	const imageId = await allocateImageId();
	const root = options.payloadStub
		? encodeKittyStub(payload.frames[0] as string, {
				columns: payload.columns,
				rows: payload.rows,
				imageId,
			})
		: await renderKittyRoot(
				payload.frames[0] as string,
				{ widthPx: payload.pixelWidth, heightPx: payload.pixelHeight },
				{ maxColumns: payload.columns, maxRows: payload.rows, imageId },
			);

	return {
		protocol: "kitty",
		frames: payload.frames.map((base64) => ({ base64 })),
		columns: root.columns,
		rows: root.rows,
		pixelWidth: payload.pixelWidth,
		pixelHeight: payload.pixelHeight,
		imageId,
		sequence: root.sequence,
		gapMs: payload.gapMs,
		gapsMs: payload.gapsMs ?? payload.frames.map(() => payload.gapMs),
		gifPath: payload.gifPath,
		totalFrames: payload.totalFrames,
		stride: payload.stride,
		palette: payload.palette,
		fromCache,
		builtAt: payload.builtAt,
	};
}
