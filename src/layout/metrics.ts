/**
 * Geometry: how many rows the splash may use, how wide the block is, how the
 * picture band is cropped, and how the kitty row count is read back.
 *
 * These are the numbers every other module budgets against; keep them in one
 * place so `render()` and the background pipeline cannot disagree.
 */

import { BANNER_MAX_WIDTH, type AutoSize, type BannerSize, type LayoutSettings } from "../config.ts";
import { KITTY_IMAGE_PREFIX, isImageLine, maxVisibleWidth, visibleWidth } from "../text.ts";
import { MIN_PANEL_WIDTH } from "./box.ts";

// ---------------------------------------------------------------------------
// inline image (kitty) layout
// ---------------------------------------------------------------------------

/** Blank rows between the image band and the boxes below it. */
export const IMAGE_GAP_ROWS = 1;
/**
 * Terminal rows pi's interactive UI keeps for itself, outside the document.
 *
 * Derived from pi's own layout (`modes/interactive/interactive-mode.js`):
 * `mountInteractiveTui()` mounts `documentContainer` above the status and
 * editor/footer containers, the editor renders 3 rows (top border, input,
 * bottom border) and the footer 2 (cwd + stats), and `headerContainer.children`
 * is `[Spacer(1), header, Spacer(1)]` — so the splash is bracketed by two blank
 * document rows. A splash taller than `terminalRows - CHROME_ROWS` therefore
 * pushes the top of the image out of the viewport, and once the image anchor
 * scrolls away pi's main-screen renderer answers the next change with
 * `fullRender(true)` (clear screen + scrollback).
 */
export const CHROME_ROWS = 7;
/** Lower-block height at which a two-column info + panel layout still reads. */
/** Even on a tall terminal the info/panel block does not grow past this. */
export const MAX_LOWER_ROWS = 14;
export const MIN_IMAGE_COLUMNS = 4;

/**
 * Block width for a terminal width, in cells. Mirrors the char-rendering
 * formula in `banner.ts` so both renderers center on the same column.
 */
/**
 * Width of the whole splash block: the configured width, capped by the
 * terminal (four columns of breathing room) and by `layout.maxWidth`.
 */
export function blockWidthFor(cols: number, layout?: LayoutSettings): number {
	const width = Math.floor(cols);
	const ceiling = layout ? Math.min(layout.maxWidth, layout.width) : BANNER_MAX_WIDTH;
	return Math.min(Math.max(20, width - 4), ceiling);
}

/**
 * Split the lower block into two panels.
 *
 * Equal halves by default (the divider sits dead centre, as the splash design
 * asks); a numeric `panels.resources.width` gives the right panel its own size
 * and the left one takes the rest.
 */
export function panelWidths(
	blockWidth: number,
	gap: number,
	preferredRight?: AutoSize,
): { left: number; right: number } {
	const usable = Math.max(2, blockWidth - gap);
	if (typeof preferredRight === "number") {
		const right = Math.min(Math.max(preferredRight, MIN_PANEL_WIDTH), usable - MIN_PANEL_WIDTH);
		return { left: usable - right, right };
	}
	const left = Math.floor(usable / 2);
	return { left, right: usable - left };
}

/**
 * Rows a splash may occupy on a `terminalRows`-row terminal: the document body
 * minus pi's chrome. Floor of 10 keeps the existing degraded layout on absurdly
 * short terminals (`render()` still clamps to the terminal width/height).
 */
export function splashRows(terminalRows: number): number {
	return Math.max(10, Math.floor(terminalRows) - CHROME_ROWS);
}

export interface ImageBandBudget {
	/** Character-grid columns the image may occupy. */
	maxColumns: number;
	/** Character-grid rows the image may occupy. */
	maxRows: number;
}

/**
 * Upper bounds handed to the image pipeline.
 *
 * Width is capped by the block (`layout.width` or `terminalCols - 4`); the height
 * is the configured picture height and never depends on the terminal. A short
 * window must not shrink the picture: the band is emitted at its full size and
 * the panel block underneath gives way instead. Shrinking the build would also
 * preserve the aspect ratio and hand back a tiny picture (a 4-row budget turns a
 * 44x22 canvas into 8x4 cells, i.e. 72px wide).
 */
export function imageBandBudget(options: {
	cols: number;
	size: BannerSize;
}): ImageBandBudget {
	const maxColumns = Math.min(options.size.width, blockWidthFor(options.cols));
	return { maxColumns: Math.max(MIN_IMAGE_COLUMNS, maxColumns), maxRows: Math.max(1, options.size.height) };
}

/**
 * Cell rows claimed by an inline image line. Same semantics as pi-tui's
 * `parseKittyImageHeader`: only the first graphics sequence (the root frame) is
 * parsed, and `r=` defaults to 1.
 */
export function parseKittyRows(line: string): number {
	const start = line.indexOf(KITTY_IMAGE_PREFIX);
	if (start === -1) return 1;
	const paramsStart = start + KITTY_IMAGE_PREFIX.length;
	const paramsEnd = line.indexOf(";", paramsStart);
	if (paramsEnd === -1) return 1;
	let rows = 1;
	for (const param of line.slice(paramsStart, paramsEnd).split(",")) {
		const [key, value] = param.split("=", 2);
		if (key !== "r" || value === undefined) continue;
		const parsed = Number(value);
		if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 0xffffffff) continue;
		rows = parsed;
	}
	return rows;
}

/**
 * Rows reserved by the image at `index`, mirroring pi-tui's
 * `getKittyImageReservedRows`. Only strictly empty continuations count: a line
 * of spaces is visible (`visibleWidth > 0`) and terminates the block.
 */
export function imageReservedRows(lines: readonly string[], index: number, maxIndex = lines.length - 1): number {
	const rows = parseKittyRows(lines[index] ?? "");
	if (rows <= 1) return 1;
	const maxRows = Math.min(rows, maxIndex - index + 1, lines.length - index);
	let reserved = 1;
	while (reserved < maxRows) {
		const line = lines[index + reserved] ?? "";
		if (isImageLine(line) || visibleWidth(line) > 0) break;
		reserved++;
	}
	return reserved;
}
