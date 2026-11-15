/**
 * Frame timing for animated gifs.
 *
 * A gif does not carry a frame *rate* — every frame carries its own delay (in
 * hundredths of a second). Playing the extracted frames on a fixed timer is
 * what makes the splash run fast: `stride: 3` drops two frames out of three, so
 * a 10 fps gif looks like 48 fps unless the remaining frames are shown three
 * times longer each.
 *
 * `probeGifTiming()` reads the delays once per gif (via ffprobe) and returns one
 * duration per *source* frame; `aggregateDelays()` folds them down to the frames
 * that survive `stride`/`maxFrames` sampling so the loop keeps its real length.
 */

import { FrameError, run } from "./process.ts";

/** What a browser does with a gif frame that declares no (or 0) delay. */
export const DEFAULT_FRAME_DELAY_MS = 100;
/** Browsers clamp 10 ms and below up to the default; so do we. */
const MIN_FRAME_DELAY_MS = 20;
const MAX_FRAME_DELAY_MS = 10_000;

export interface GifTiming {
	/** One entry per source frame, in milliseconds. */
	delays: number[];
	/** Sum of `delays` — the real length of one loop. */
	totalMs: number;
}

/**
 * Per-frame delays of `gifPath`, in source order.
 *
 * Never throws: a gif ffprobe cannot read (or one frame only) falls back to
 * `DEFAULT_FRAME_DELAY_MS`, because a splash with slightly wrong pacing beats a
 * splash that refuses to animate.
 */
export async function probeGifTiming(gifPath: string, timeoutMs = 20_000): Promise<GifTiming> {
	let stamps: number[] = [];
	let totalMs = 0;
	try {
		const { stdout } = await run(
			"ffprobe",
			[
				"-v",
				"error",
				"-select_streams",
				"v:0",
				"-show_entries",
				"frame=pts_time",
				"-of",
				"csv=p=0",
				gifPath,
			],
			timeoutMs,
		);
		stamps = String(stdout)
			.split(/\r?\n/)
			.map((line) => Number.parseFloat(line.trim()))
			.filter((value) => Number.isFinite(value) && value >= 0);
	} catch {
		return { delays: [DEFAULT_FRAME_DELAY_MS], totalMs: DEFAULT_FRAME_DELAY_MS };
	}
	if (stamps.length === 0) {
		return { delays: [DEFAULT_FRAME_DELAY_MS], totalMs: DEFAULT_FRAME_DELAY_MS };
	}

	try {
		const { stdout } = await run(
			"ffprobe",
			["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", gifPath],
			timeoutMs,
		);
		const value = Number.parseFloat(String(stdout).trim());
		if (Number.isFinite(value) && value > 0) totalMs = Math.round(value * 1000);
	} catch {
		totalMs = 0;
	}

	const delays: number[] = [];
	for (let index = 0; index < stamps.length; index++) {
		const next = stamps[index + 1];
		const current = stamps[index] as number;
		if (next !== undefined) {
			delays.push(clampDelay(Math.round((next - current) * 1000)));
			continue;
		}
		// Last frame: everything the container says is left (some encoders report
		// a duration that ends before the last stamp).
		const tail = totalMs > 0 ? totalMs - Math.round(current * 1000) : DEFAULT_FRAME_DELAY_MS;
		delays.push(clampDelay(tail));
	}

	const sum = delays.reduce((acc, value) => acc + value, 0);
	return { delays, totalMs: sum > 0 ? sum : DEFAULT_FRAME_DELAY_MS };
}

function clampDelay(value: number): number {
	if (!Number.isFinite(value) || value <= MIN_FRAME_DELAY_MS) return DEFAULT_FRAME_DELAY_MS;
	return Math.min(MAX_FRAME_DELAY_MS, Math.round(value));
}

/**
 * Fold source delays down to the sampled frames.
 *
 * `kept` are the source indices that survived sampling (ascending). Each kept
 * frame inherits the delays of the frames it swallowed, so one loop still lasts
 * `totalMs` no matter how aggressively the gif was thinned.
 */
export function aggregateDelays(delays: readonly number[], kept: readonly number[]): number[] {
	if (delays.length === 0) return kept.map(() => DEFAULT_FRAME_DELAY_MS);
	const out: number[] = [];
	for (let index = 0; index < kept.length; index++) {
		const from = kept[index] as number;
		const to = (kept[index + 1] ?? delays.length) as number;
		let sum = 0;
		for (let source = from; source < to; source++) sum += delays[source] ?? DEFAULT_FRAME_DELAY_MS;
		out.push(clampDelay(sum));
	}
	return out.length > 0 ? out : [DEFAULT_FRAME_DELAY_MS];
}

/** Even sampling indices: 0, n, 2n, … — the same rule the pipelines use. */
export function sampledIndices(count: number, stride: number): number[] {
	const step = Math.max(1, Math.floor(stride));
	const out: number[] = [];
	for (let index = 0; index < count; index += step) out.push(index);
	return out.length > 0 ? out : [0];
}

/** Split `count` frames into `keep` evenly spread indices (decimation). */
export function decimatedIndices(count: number, keep: number): number[] {
	if (count <= 0) return [];
	const limit = Math.max(1, Math.min(count, Math.floor(keep)));
	const out: number[] = [];
	for (let index = 0; index < limit; index++) {
		out.push(Math.min(count - 1, Math.round((index * count) / limit)));
	}
	return out;
}

/**
 * The timing shown by `preview` and `/splash status`: total loop length and the
 * average frame rate, both taken from the gif itself.
 */
export function describeTiming(delays: readonly number[]): string {
	if (delays.length === 0) return "0 frames";
	const total = delays.reduce((acc, value) => acc + value, 0);
	return `${delays.length}f/${(total / 1000).toFixed(2)}s ${(delays.length / (total / 1000)).toFixed(1)}fps`;
}

/**
 * Thin per-frame delays with exactly the index mapping `decimate()` uses, so a
 * thinned frame list always carries a matching delay list whose sum is the
 * original loop length.
 */
export function thinDelays(delays: readonly number[], max: number): number[] {
	if (max <= 0) return [];
	if (delays.length <= max) return [...delays];
	if (max === 1) return [delays.reduce((acc, value) => acc + value, 0)];
	const out: number[] = [];
	const span = (index: number): number => Math.floor((index * (delays.length - 1)) / (max - 1));
	for (let index = 0; index < max; index++) {
		const from = span(index);
		const to = index === max - 1 ? delays.length : span(index + 1);
		let sum = 0;
		for (let source = from; source < to; source++) sum += delays[source] ?? 0;
		out.push(Math.max(1, Math.round(sum)));
	}
	return out;
}
