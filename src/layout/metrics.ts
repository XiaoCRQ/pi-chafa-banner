/**
 * Geometry: how many rows the splash may use and how wide its block is.
 *
 * These are the numbers every other module budgets against; keep them in one
 * place so the renderer and the background pipeline cannot disagree.
 */

import { BANNER_MAX_WIDTH, type LayoutSettings } from "../config.ts";

/**
 * Terminal rows pi's interactive UI keeps for itself, outside the document.
 *
 * Derived from pi's own layout (`modes/interactive/interactive-mode.js`):
 * `mountInteractiveTui()` mounts `documentContainer` above the status and
 * editor/footer containers, the editor renders 3 rows (top border, input,
 * bottom border) and the footer 2 (cwd + stats), and `headerContainer.children`
 * is `[Spacer(1), header, Spacer(1)]` — so the splash is bracketed by two blank
 * document rows.
 */
export const CHROME_ROWS = 7;

/** Rows the document body can show without pushing pi's editor off screen. */
export function splashRows(terminalRows: number): number {
	const rows = Number.isFinite(terminalRows) ? Math.floor(terminalRows) : 40;
	return Math.max(10, rows - CHROME_ROWS);
}

/**
 * Width of the whole splash block: the configured width, capped by `layout.maxWidth`.
 *
 * When the terminal is at least as wide as the ceiling the block is exactly that
 * wide — the canvas is derived from the same number (`derivedCanvas(layout)`), so
 * the artwork fills its column column-for-column. Narrower terminals keep four
 * columns of breathing room and the art is clipped to fit.
 */
export function blockWidthFor(cols: number, layout?: LayoutSettings): number {
	const width = Math.floor(cols);
	const ceiling = layout ? Math.min(layout.maxWidth, layout.width) : BANNER_MAX_WIDTH;
	const available = width >= ceiling ? ceiling : Math.max(20, width - 4);
	return Math.min(available, ceiling);
}
