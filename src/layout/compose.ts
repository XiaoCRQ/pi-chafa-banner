/**
 * Composition helpers: place two boxes side by side, center or clamp a finished
 * block, and the three-line fallback used by terminals too narrow for boxes.
 */

import { centerVisible, isImageLine, maxVisibleWidth, padVisible, truncateToWidth, visibleWidth } from "../text.ts";
import type { Painter } from "./box.ts";

// ---------------------------------------------------------------------------
// composition
// ---------------------------------------------------------------------------

/**
 * Place two blocks side by side, left padded to its own width, right as-is.
 * Lines shorter on either side are blank-filled so borders stay aligned.
 * Inline image lines are passed through untouched (they are zero-width
 * placeholders for a cell block the terminal draws over).
 */
export function twoColumn(left: readonly string[], right: readonly string[], gap: number, totalWidth: number): string[] {
	const leftWidth = maxVisibleWidth(left);
	const separator = " ".repeat(Math.max(0, gap));
	const rows = Math.max(left.length, right.length);
	const out: string[] = [];
	for (let index = 0; index < rows; index++) {
		const l = left[index] ?? "";
		const r = right[index] ?? "";
		if (isImageLine(l) || isImageLine(r)) {
			out.push(l || r);
			continue;
		}
		const line = `${padVisible(l, leftWidth)}${separator}${r}`;
		out.push(truncateToWidth(line, Math.max(1, totalWidth), ""));
	}
	return out;
}

/** Horizontally center a block inside `width`, padding on the left only. */
export function centerBlock(lines: readonly string[], width: number): string[] {
	const blockWidth = maxVisibleWidth(lines);
	if (blockWidth >= width) return clampLines(lines, width);
	const pad = Math.max(0, Math.floor((width - blockWidth) / 2));
	if (pad === 0) return [...lines];
	return lines.map((line) => " ".repeat(pad) + line);
}

/** Safety net: clip every line to the terminal width (no padding added). */
export function clampLines(lines: readonly string[], width: number): string[] {
	const limit = Math.max(1, Math.floor(width));
	return lines.map((line) => (line === "" || isImageLine(line) ? line : truncateToWidth(line, limit, "")));
}

/** 3-line splash for terminals too narrow for boxes (< 32 columns). */
export function compactSplash(width: number, painter: Painter, info: { version: string; model: string; thinking: string }): string[] {
	// Same shape as the info card: the thinking level trails the model.
	const model = info.thinking === "unknown" ? info.model : `${info.model} · ${info.thinking}`;
	const lines = [
		`${painter.bold(painter.fg("accent", "π pi-chafa-banner"))} ${info.version}`,
		painter.fg("text", model),
		painter.fg("dim", "chafa"),
	];
	return lines.map((line) => centerVisible(truncateToWidth(line, Math.max(1, width), "…"), width).trimEnd());
}
