/**
 * Process plumbing shared by both pipelines: spawn-without-tty, tool preflight
 * and the gif fingerprint used for cache keys.
 *
 * Spawning with `stdio: ["ignore", ...]` is deliberate: a pty would let chafa or
 * ffmpeg talk to the terminal and corrupt the running TUI.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";

/** Any pipeline failure; `code` lets callers shape the user-facing notice. */
export class FrameError extends Error {
	constructor(
		readonly code: "no-gif" | "missing-tool" | "ffmpeg" | "ffprobe" | "chafa" | "empty",
		message: string,
	) {
		super(message);
		this.name = "FrameError";
	}
}

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

// ---------------------------------------------------------------------------
// artwork probing
// ---------------------------------------------------------------------------

export interface SourceSize {
	width: number;
	height: number;
}

/**
 * Pixel size of the artwork's first frame.
 *
 * Needed for `image.height: "auto"`: chafa wants a cell grid, and the only way
 * to keep the gif's aspect ratio is to know the source's.
 */
export async function probeSourceSize(gifPath: string, timeoutMs = 10_000): Promise<SourceSize> {
	let stdout: string;
	try {
		({ stdout } = await run(
			"ffprobe",
			[
				"-v",
				"error",
				"-select_streams",
				"v:0",
				"-show_entries",
				"stream=width,height",
				"-of",
				"csv=p=0:s=x",
				gifPath,
			],
			timeoutMs,
		));
	} catch (error) {
		throw new FrameError("ffprobe", `ffprobe could not read ${gifPath}: ${(error as Error)?.message ?? error}`);
	}
	const [width, height] = (stdout.trim().split("\n")[0] ?? "").split("x").map(Number);
	if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
		throw new FrameError("ffprobe", `could not read the size of ${gifPath}`);
	}
	return { width: width as number, height: height as number };
}
