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
export const MIN_LOWER_ROWS = 11;
/** Even on a tall terminal the info/panel block does not grow past this. */
export const MAX_LOWER_ROWS = 14;
export const MIN_IMAGE_ROWS = 4;
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
 * Keep the top `rows` of a character-art frame, biased upwards so faces survive
 * (same 1/3 rule as `planImageBand`).
 */
export function cropTopRows(lines: readonly string[], rows: number): string[] {
	if (rows >= lines.length) return [...lines];
	if (rows <= 0) return [];
	const hidden = Math.floor(((lines.length - rows) * 1) / 3);
	return lines.slice(hidden, hidden + rows);
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
 * Width is capped by the block (`PI_BANNER_SIZE` or `terminalCols - 4`), but the
 * *height* is deliberately not. Short terminals are handled at render time by
 * `planImageBand()`, which crops the source rectangle; shrinking the build
 * instead would preserve the aspect ratio and hand back a tiny picture (a 4-row
 * budget turns a 44x22 canvas into 8x4 cells, i.e. 72px wide). Keeping the build
 * at the requested size also means growing the window reuses the cache instead
 * of re-encoding, and only a width shrink triggers a rebuild.
 */
export function imageBandBudget(options: {
	cols: number;
	size: BannerSize;
}): ImageBandBudget {
	const maxColumns = Math.min(options.size.width, blockWidthFor(options.cols));
	return { maxColumns: Math.max(MIN_IMAGE_COLUMNS, maxColumns), maxRows: Math.max(MIN_IMAGE_ROWS, options.size.height) };
}

/**
 * How the picture band is laid out for the current terminal.
 *
 * A short terminal must never make the picture vanish: instead the source
 * rectangle (kitty `x=/y=/w=/h=`) is cropped, so the placement always occupies
 * real rows. Cropping happens before any network-free re-encode, which keeps
 * `render()` synchronous.
 */
export interface ImageBandPlan {
	/** Cell rows the placement occupies (`r=` after cropping). */
	rows: number;
	/** Cell columns the placement occupies (`c=` after cropping). */
	columns: number;
	/** Rows cut off the top of the source picture. */
	hiddenRows: number;
	/** Columns cut off the left of the source picture. */
	hiddenColumns: number;
	/** Source rectangle in image pixels. */
	sourceX: number;
	sourceY: number;
	sourceWidth: number;
	sourceHeight: number;
	/** `true` when nothing is cropped (the sequence can be used verbatim). */
	whole: boolean;
}

/**
 * Fit a built picture into the document body, cropping instead of dropping it.
 *
 * The band keeps `lowerRows` rows for the info card/panel when the terminal is
 * tall enough; below that it shrinks only down to `minRows` and lets the lower
 * block degrade. Returns `undefined` when even the minimum does not fit — the
 * caller then falls back to the placeholder card.
 */
export function planImageBand(options: {
	/** Rows of document body available (see `splashRows`). */
	totalRows: number;
	statusRows: number;
	/** Columns the image line may span, minus the block's left pad. */
	availableColumns: number;
	image: { rows: number; columns: number; pixelWidth: number; pixelHeight: number };
	/** Rows the lower block should keep while the picture still fits. */
	lowerRows?: number;
	/** Absolute floor for the picture band. */
	minRows?: number;
}): ImageBandPlan | undefined {
	const image = options.image;
	const minRows = Math.max(1, Math.floor(options.minRows ?? MIN_IMAGE_ROWS));
	const lowerRows = Math.max(0, Math.floor(options.lowerRows ?? MIN_LOWER_ROWS));
	const available = Math.max(0, Math.floor(options.availableColumns));
	if (available < Math.min(MIN_IMAGE_COLUMNS, image.columns)) return undefined;

	const maxRows = Math.max(0, options.totalRows - options.statusRows - IMAGE_GAP_ROWS);
	if (maxRows < 1) return undefined;
	const preferred = image.rows <= maxRows - lowerRows ? image.rows : Math.max(minRows, maxRows - lowerRows);
	const rows = Math.max(1, Math.min(image.rows, maxRows, Math.max(1, preferred)));
	const columns = Math.max(1, Math.min(image.columns, available));

	// Bias the crop towards the top: anime/still art rarely has its subject in
	// the bottom third, and a centred crop cuts faces in half.
	const hiddenRows = rows >= image.rows ? 0 : Math.floor(((image.rows - rows) * 1) / 3);
	const hiddenColumns = columns >= image.columns ? 0 : Math.floor((image.columns - columns) / 2);
	const sourceY = Math.floor((image.pixelHeight * hiddenRows) / image.rows);
	const sourceEndY = Math.ceil((image.pixelHeight * (hiddenRows + rows)) / image.rows);
	const sourceX = Math.floor((image.pixelWidth * hiddenColumns) / image.columns);
	const sourceEndX = Math.ceil((image.pixelWidth * (hiddenColumns + columns)) / image.columns);

	return {
		rows,
		columns,
		hiddenRows,
		hiddenColumns,
		sourceX,
		sourceY,
		sourceWidth: Math.max(1, Math.min(image.pixelWidth, sourceEndX) - sourceX),
		sourceHeight: Math.max(1, Math.min(image.pixelHeight, sourceEndY) - sourceY),
		whole: hiddenRows === 0 && hiddenColumns === 0 && rows === image.rows && columns === image.columns,
	};
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
