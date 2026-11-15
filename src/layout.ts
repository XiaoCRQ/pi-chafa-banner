/**
 * Pure layout layer: turns plain data (frame lines, info rows, resource
 * sections) into boxed, aligned, width-safe terminal lines.
 *
 * No I/O, no pi imports, no timers — everything here is unit-testable and takes
 * a `Painter` so tests can run with colors disabled.
 *
 * Invariant enforced by every exported function: no returned line is wider than
 * the width it was given. pi's renderer relies on that.
 */

import { BANNER_MAX_WIDTH, type AutoSize, type BannerSize, type LayoutSettings } from "./config.ts";
import {
	centerVisible,
	isImageLine,
	KITTY_IMAGE_PREFIX,
	maxVisibleWidth,
	padVisible,
	truncateToWidth,
	visibleWidth,
} from "./text.ts";

/** Narrowest panel that still renders a readable box. */
export const MIN_PANEL_WIDTH = 28;

export type ColorToken =
	| "borderMuted"
	| "mdHeading"
	| "dim"
	| "mdCode"
	| "text"
	| "accent"
	| "muted"
	| "warning";

/** The tiny slice of `Theme` the layout needs; stub it in tests. */
export interface Painter {
	fg(token: ColorToken, text: string): string;
	bold(text: string): string;
}

export const plainPainter: Painter = {
	fg: (_token, text) => text,
	bold: (text) => text,
};

export interface ThemeLike {
	fg(token: string, text: string): string;
	bold(text: string): string;
}

export function themePainter(theme: ThemeLike): Painter {
	return {
		fg: (token, text) => theme.fg(token, text),
		bold: (text) => theme.bold(text),
	};
}

export interface BoxStyle {
	tl: string;
	tr: string;
	bl: string;
	br: string;
	h: string;
	v: string;
}

export const THIN_BOX: BoxStyle = { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│" };

export interface PanelOptions {
	/** Total number of lines the box should occupy (body is padded with blanks). */
	fillTo?: number;
	style?: BoxStyle;
}

export interface InfoRow {
	label: string;
	value: string;
}

export interface ResourceSection {
	title: string;
	names: readonly string[];
}

/**
 * Draw a bordered box. `width` is the outer width; every line is exactly
 * `width` columns. A title, when present, is centered in the top border.
 */
export function panel(
	title: string | undefined,
	body: readonly string[],
	width: number,
	painter: Painter,
	options: PanelOptions = {},
): string[] {
	const style = options.style ?? THIN_BOX;
	const w = Math.max(4, Math.floor(width));
	const inner = w - 2;
	// Content area is "│ " + text + " │", i.e. w - 4 columns.
	const contentWidth = Math.max(0, w - 4);
	const border = (ch: string) => painter.fg("borderMuted", ch);

	let top: string;
	if (title && contentWidth >= 6) {
		const styled = painter.bold(painter.fg("mdHeading", ` ${title} `));
		const titleWidth = Math.min(visibleWidth(styled), inner);
		const leftDashes = Math.max(0, Math.floor((inner - titleWidth) / 2));
		const rightDashes = Math.max(0, inner - titleWidth - leftDashes);
		top =
			border(style.tl) +
			border(style.h.repeat(leftDashes)) +
			truncateToWidth(styled, titleWidth, "") +
			border(style.h.repeat(rightDashes)) +
			border(style.tr);
	} else {
		top = border(style.tl) + border(style.h.repeat(inner)) + border(style.tr);
	}

	const rows: string[] = [];
	const targetBody = options.fillTo === undefined ? undefined : Math.max(0, options.fillTo - 2);
	for (const line of body) {
		if (targetBody !== undefined && rows.length >= targetBody) break;
		rows.push(border(style.v) + " " + truncateToWidth(line, contentWidth, "…", true) + " " + border(style.v));
	}
	if (targetBody !== undefined) {
		const blank = border(style.v) + " ".repeat(contentWidth + 2) + border(style.v);
		while (rows.length < targetBody) rows.push(blank);
	}

	const bottom = border(style.bl) + border(style.h.repeat(inner)) + border(style.br);
	return [truncateToWidth(top, w, ""), ...rows, bottom];
}

/** Bordered card with one aligned `label  value` row per info field. */
export function infoBox(
	title: string,
	rows: readonly InfoRow[],
	width: number,
	painter: Painter,
	options: PanelOptions = {},
): string[] {
	const contentWidth = Math.max(0, Math.floor(width) - 4);
	const labelWidth = rows.reduce((max, row) => Math.max(max, visibleWidth(row.label)), 0);
	const valueWidth = Math.max(1, contentWidth - labelWidth - 2);
	const body = rows.map((row) => {
		const label = painter.fg("muted", padVisible(row.label, labelWidth));
		const value = painter.fg("text", truncateToWidth(row.value, valueWidth, "…"));
		return `${label}  ${value}`;
	});
	return panel(title, body, width, painter, options);
}

// ---------------------------------------------------------------------------
// lists
// ---------------------------------------------------------------------------

/** Greedy comma wrap: first line starts flush, continuations are indented by 2. */
export function wrapNames(names: readonly string[], width: number, maxLines = Number.POSITIVE_INFINITY): string[] {
	const indent = "  ";
	const avail = Math.max(4, Math.floor(width));
	const out: string[] = [];
	let current = indent;
	let hasItem = false;
	let overflow = false;

	for (let index = 0; index < names.length; index++) {
		const name = names[index] ?? "";
		const candidate = hasItem ? `${current}, ${name}` : `${current}${name}`;
		if (visibleWidth(candidate) <= avail) {
			current = candidate;
			hasItem = true;
			continue;
		}
		// Start a new line when there is still budget for one more line after it.
		if (hasItem && out.length + 1 < maxLines) {
			out.push(current);
			current = indent;
			hasItem = false;
			index -= 1;
			continue;
		}
		const prefix = hasItem ? `${current}, ` : current;
		current = prefix + truncateToWidth(name, avail - visibleWidth(prefix), "…");
		hasItem = true;
		overflow = true;
		break;
	}
	if (hasItem) out.push(current);
	if (out.length === 0) out.push(indent);
	if (overflow) out[out.length - 1] = appendEllipsis(out[out.length - 1] ?? indent, avail);
	return out.slice(0, Math.max(1, maxLines));
}

function appendEllipsis(line: string, width: number): string {
	const combined = `${line}, ...`;
	if (visibleWidth(combined) <= width) return combined;
	const room = width - visibleWidth(", ...");
	return room <= 0 ? truncateToWidth(line, width, "…") : `${truncateToWidth(line, room, "")}, ...`;
}

/**
 * Water-filling row budget: every list keeps at least one line, spare rows go to
 * whichever list is still the most truncated (same policy as beautiful-pi).
 */
export function distributeLines(needs: readonly number[], budget: number): number[] {
	const caps = needs.map(() => 1);
	let remaining = Math.max(0, Math.floor(budget) - needs.length);
	while (remaining > 0) {
		let best = -1;
		let bestGap = 0;
		for (let index = 0; index < needs.length; index++) {
			const gap = (needs[index] ?? 0) - (caps[index] ?? 0);
			if (gap > bestGap) {
				bestGap = gap;
				best = index;
			}
		}
		if (best < 0) break;
		caps[best] = (caps[best] ?? 1) + 1;
		remaining -= 1;
	}
	return caps;
}

/** `[Context]` heading plus dim, wrapped, 2-space-indented names. */
export function resourceSection(
	title: string,
	names: readonly string[],
	width: number,
	painter: Painter,
	maxLines = Number.POSITIVE_INFINITY,
): string[] {
	const out = [painter.bold(painter.fg("mdHeading", `[${title}]`))];
	if (names.length === 0) {
		out.push(painter.fg("dim", "  (none)"));
		return out;
	}
	for (const line of wrapNames(names, width, maxLines)) out.push(painter.fg("dim", line));
	return out;
}

/**
 * Bordered RESOURCES panel. When `totalRows` is given the box is padded to that
 * exact height so it lines up with the left column; sections are row-budgeted and
 * overflow collapses to ", ...".
 */
export function resourcePanel(
	title: string,
	sections: readonly ResourceSection[],
	width: number,
	painter: Painter,
	totalRows?: number,
	options: { style?: BoxStyle; maxLinesPerSection?: number } = {},
): string[] {
	const style = options.style ?? THIN_BOX;
	const contentWidth = Math.max(4, Math.floor(width) - 4);
	const finiteRows = totalRows !== undefined && Number.isFinite(totalRows);
	const usableRows = finiteRows ? Math.max(0, (totalRows as number) - 2) : Number.POSITIVE_INFINITY;
	const maxSections = finiteRows ? Math.max(1, Math.floor(usableRows / 2)) : sections.length;
	const kept = sections.slice(0, maxSections);

	const cap = options.maxLinesPerSection;
	const needs = kept.map((section) => {
		const lines = section.names.length === 0 ? 1 : wrapNames(section.names, contentWidth).length;
		return cap === undefined ? lines : Math.min(lines, Math.max(1, cap));
	});
	const bodyBudget = finiteRows ? Math.max(kept.length, usableRows - kept.length) : Number.MAX_SAFE_INTEGER;
	const caps = finiteRows ? distributeLines(needs, bodyBudget) : needs;

	const body: string[] = [];
	kept.forEach((section, index) => {
		body.push(...resourceSection(section.title, section.names, contentWidth, painter, caps[index] ?? 1));
	});
	return panel(title, body, width, painter, { fillTo: totalRows, style });
}

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
export function compactSplash(width: number, painter: Painter, info: { version: string; model: string; theme: string }): string[] {
	const lines = [
		`${painter.bold(painter.fg("accent", "π pi"))} ${info.version}`,
		painter.fg("text", info.model),
		painter.fg("dim", `${info.theme} · chafa`),
	];
	return lines.map((line) => centerVisible(truncateToWidth(line, Math.max(1, width), "…"), width).trimEnd());
}

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
