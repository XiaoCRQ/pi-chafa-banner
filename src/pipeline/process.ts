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
		readonly code: "no-gif" | "missing-tool" | "ffmpeg" | "chafa" | "empty" | "image",
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
