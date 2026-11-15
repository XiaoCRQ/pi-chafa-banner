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

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { formatSize, piAgentDir, type BannerConfig, type BannerSize } from "./config.ts";
import { padVisible, truncateToWidth, visibleWidth } from "./text.ts";

export interface FrameSet {
	frames: string[][];
	width: number;
	height: number;
	colorMode: string;
	gifPath: string;
	totalFrames: number;
	stride: number;
	fromCache: boolean;
	builtAt: number;
}

export class FrameError extends Error {
	constructor(
		readonly code: "no-gif" | "missing-tool" | "ffmpeg" | "chafa" | "empty" | "image",
		message: string,
	) {
		super(message);
		this.name = "FrameError";
	}
}

export const CACHE_VERSION = 1;
export const MAX_GIF_FRAMES = 240;

// ---------------------------------------------------------------------------
// process helpers
// ---------------------------------------------------------------------------

interface RunResult {
	stdout: string;
	stderr: string;
}

const OUTPUT_LIMIT = 32 * 1024 * 1024;

/**
 * Spawn without a tty (stdin ignored). A pty would let chafa/ffmpeg interact
 * with the terminal and corrupt the running TUI.
 */
export function run(command: string, args: string[], timeoutMs = 20_000): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let settled = false;

		const finish = (error: Error | undefined) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error) reject(error);
			else resolve({ stdout, stderr });
		};

		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(new Error(`${command} timed out after ${timeoutMs}ms`));
		}, timeoutMs);

		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
			if (stdout.length > OUTPUT_LIMIT) {
				child.kill("SIGKILL");
				finish(new Error(`${command} produced more than ${OUTPUT_LIMIT} bytes`));
			}
		});
		child.stderr?.on("data", (chunk: string) => {
			if (stderr.length < 64_000) stderr += chunk;
		});
		child.on("error", (error) => finish(error));
		child.on("close", (code, signal) => {
			if (code === 0) {
				finish(undefined);
				return;
			}
			const reason = signal ? `signal ${signal}` : `exit code ${code}`;
			const detail = stderr.trim().split("\n").slice(-3).join(" ").trim();
			finish(new Error(`${command} failed (${reason})${detail ? `: ${detail}` : ""}`));
		});
	});
}

/**
 * Split the preflight result by what a renderer actually needs: the char
 * renderer drives chafa *and* ffmpeg, the kitty renderer only needs ffmpeg (the
 * PNGs are encoded, never rasterized into cells).
 */
export function missingToolsFor(result: PreflightResult, need: "chars" | "kitty"): string[] {
	const required = need === "kitty" ? ["ffmpeg"] : ["chafa", "ffmpeg"];
	return required.filter((bin) => result.missing.includes(bin));
}

export interface PreflightResult {
	ok: boolean;
	missing: string[];
	versions: Record<string, string>;
}

let preflightCache: PreflightResult | undefined;

/** Probe chafa/ffmpeg once per process; `/splash status` reuses the result. */
export async function preflight(force = false): Promise<PreflightResult> {
	if (preflightCache && !force) return preflightCache;
	const versions: Record<string, string> = {};
	const missing: string[] = [];
	for (const [bin, args] of [
		["chafa", ["--version"]],
		["ffmpeg", ["-version"]],
	] as const) {
		try {
			const { stdout, stderr } = await run(bin, [...args], 5_000);
			// ffmpeg prints its banner on stdout, chafa on stdout too; join for safety.
			const first = `${stdout}${stderr}`.split("\n").find((line) => line.trim().length > 0) ?? "";
			versions[bin] = first.trim();
		} catch {
			missing.push(bin);
		}
	}
	preflightCache = { ok: missing.length === 0, missing, versions };
	return preflightCache;
}

// ---------------------------------------------------------------------------
// cache
// ---------------------------------------------------------------------------

/** sha1(path + mtime + size): a cheap "is this the same gif" fingerprint. */
export async function gifHash(gifPath: string): Promise<string> {
	let info: Awaited<ReturnType<typeof stat>>;
	try {
		info = await stat(gifPath);
	} catch (error) {
		// Callers only care about "no usable gif", not about ENOENT vs EACCES.
		throw new FrameError("no-gif", `cannot read ${gifPath}: ${(error as NodeJS.ErrnoException).code ?? "error"}`);
	}
	if (!info.isFile()) throw new FrameError("no-gif", `not a file: ${gifPath}`);
	return createHash("sha1").update(`${gifPath}\0${info.mtimeMs}\0${info.size}`).digest("hex");
}

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

export function cacheRoot(): string {
	return join(piAgentDir(), "tmp", "pi-chafa-banner");
}

export async function frameCachePath(gifPath: string, size: BannerSize, colorMode: string): Promise<string> {
	const hash = await gifHash(gifPath);
	return join(cacheRoot(), hash, `frames-${formatSize(size)}-${normalizeColorMode(colorMode)}.json`);
}

/** Delete exactly one cache file (never a directory tree). */
export async function clearCache(config: BannerConfig, colorMode: string): Promise<boolean> {
	if (!config.gifPath) return false;
	try {
		const path = await frameCachePath(config.gifPath, config.size, colorMode);
		await rm(path, { force: true });
		return true;
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
		v.frames.every((frame) => Array.isArray(frame) && frame.every((line) => typeof line === "string"))
	);
}

async function readCache(
	path: string,
	size: BannerSize,
	colorMode: string,
): Promise<CachePayload | undefined> {
	try {
		const raw = await readFile(path, "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (!isFrameSetLike(parsed)) return undefined;
		if (parsed.width !== size.width || parsed.height !== size.height) return undefined;
		if (normalizeColorMode(parsed.colorMode) !== normalizeColorMode(colorMode)) return undefined;
		return parsed;
	} catch {
		return undefined;
	}
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
		const picked: string[] = [];
		for (let index = 0; index < files.length; index += stride) picked.push(files[index]!);

		const frames: string[][] = [];
		for (const file of picked) {
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
			if (frame.some((line) => visibleWidth(line) > 0)) frames.push(frame);
		}
		if (frames.length === 0) {
			throw new FrameError("chafa", "chafa produced no renderable frames");
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
			builtAt,
			frames,
		};
		await writeCache(cachePath, payload);

		return {
			frames,
			width: size.width,
			height: size.height,
			colorMode: normalizeColorMode(colorMode),
			gifPath,
			totalFrames: files.length,
			stride,
			fromCache: false,
			builtAt,
		};
	} finally {
		// Explicit path from mkdtemp; never a wildcard.
		await rm(workDir, { recursive: true, force: true }).catch(() => undefined);
	}
}

async function writeCache(path: string, payload: CachePayload): Promise<void> {
	try {
		await mkdir(dirname(path), { recursive: true });
		const tmpFile = `${path}.${process.pid}.tmp`;
		await writeFile(tmpFile, JSON.stringify(payload), "utf8");
		await rename(tmpFile, path);
	} catch {
		// Cache is best-effort: a read-only ~/.pi must not break the splash.
	}
}
