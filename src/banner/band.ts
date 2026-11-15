/**
 * The picture band: turns an `ImageFrameSet` into the one (or many) kitty
 * sequence lines the terminal draws.
 *
 * Two modes, both fully pre-rendered here so `render()` never touches the
 * terminal:
 *   - `anim`   — one constant line; the terminal loops the frames itself, so pi
 *                sees no diff and never re-renders the document.
 *   - `frames` — one root sequence per frame, swapped by the timer (escape hatch
 *                for terminals that ignore `a=f`).
 *
 * Built sequences are ~100 KB each, so the result is memoized per image id,
 * mode, frame and crop rectangle.
 */

import type { ImageFrameSet } from "../images.ts";
import { buildKittyLine, cropKittyRoot, replaceKittyPayload } from "../kitty.ts";
import type { ImageBandPlan } from "../layout.ts";

/** Upper bound for the memo: `frames` mode needs one entry per frame. */
const MAX_CACHED_LINES = 32;

/**
 * Keyed by the image-set object itself, so a rebuilt (or later) image with a
 * recycled id can never be served a stale sequence, and disposing a banner drops
 * its entries with the object.
 */
let cache = new WeakMap<ImageFrameSet, Map<string, string>>();
let entries = 0;

/** Drop every memoized line (new image set, mode or frame index). */
export function clearImageLineCache(): void {
	cache = new WeakMap();
	entries = 0;
}

/** How many lines are memoized right now (test/diagnostic hook). */
export function cachedImageLineCount(): number {
	return entries;
}

function remember(images: ImageFrameSet, key: string, line: string): string {
	let lines = cache.get(images);
	if (!lines) {
		lines = new Map();
		cache.set(images, lines);
	}
	if (!lines.has(key)) {
		if (lines.size >= MAX_CACHED_LINES) {
			const oldest = lines.keys().next();
			if (!oldest.done) lines.delete(oldest.value);
		}
		entries += 1;
	}
	lines.set(key, line);
	return line;
}

function cached(images: ImageFrameSet, key: string, build: () => string): string {
	const hit = cache.get(images)?.get(key);
	if (hit !== undefined) return hit;
	return remember(images, key, build());
}

function baseLine(
	images: ImageFrameSet,
	options: { animate: boolean; kittyMode: "anim" | "frames"; frameIndex: number },
): string {
	if (options.animate && options.kittyMode === "frames") {
		const index = Math.min(Math.max(0, options.frameIndex), Math.max(0, images.frames.length - 1));
		if (index === 0) return images.sequence;
		const payload = images.frames[index]?.base64;
		if (payload === undefined) return images.sequence;
		return cached(images, `frame|${index}`, () => replaceKittyPayload(images.sequence, payload));
	}
	return cached(images, `anim|${options.animate}`, () =>
		buildKittyLine({ images, animate: options.animate, loopForever: true }),
	);
}

/**
 * The line to render: the full picture, or the same transmission with a cropped
 * source rectangle (`x/y/w/h`) when the terminal cannot fit all of it.
 */
export function buildImageLine(
	images: ImageFrameSet,
	options: { animate: boolean; kittyMode: "anim" | "frames"; frameIndex: number; plan?: ImageBandPlan },
): string {
	const base = baseLine(images, options);
	const plan = options.plan;
	if (!plan || plan.whole) return base;
	const key = `crop|${options.animate}|${options.frameIndex}|${options.kittyMode}|${plan.rows}x${plan.columns}@${plan.sourceX},${plan.sourceY},${plan.sourceWidth}x${plan.sourceHeight}`;
	return cached(images, key, () => cropKittyRoot(base, plan));
}
