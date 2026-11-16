/**
 * Boxes and text fitting: borders, wrapped name lists, and the row budget that
 * decides how many lines each resource section gets.
 *
 * Everything here is pure and takes a `Painter`, so tests run without colors.
 */

import { centerVisible, truncateToWidth, visibleWidth } from "../text.ts";
import { paintForeground, resolvePalette, type PaletteSettings } from "./palette.ts";


/** Narrowest panel that still renders a readable box. */
export const MIN_PANEL_WIDTH = 28;

/**
 * Colour roles the layout asks for.
 *
 * `border`, `windowTitle` and `sectionTitle` are the themable box parts;
 * `text`/`muted`/`dim` are the three intensities of body content, which a single
 * `theme.content` colour collapses onto one.
 */
export type ColorToken =
	| "border"
	| "windowTitle"
	| "sectionTitle"
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
	/** Present on pi's real `Theme`; optional so tests can stub a flat one. */
	getColorMode?(): string;
}

/**
 * Painter over pi's theme, with the splash palette layered on top.
 *
 * Every role falls back to pi's own token when neither the preset nor the
 * config file sets it, so `"preset": "pi"` looks exactly like the unthemed
 * banner and still follows light/dark theme switches. The default preset is
 * `"tokyonight"`, which pins all four roles instead.
 */
export function themePainter(theme: ThemeLike, settings?: PaletteSettings): Painter {
	const palette = resolvePalette(settings);
	const mode = theme.getColorMode?.() === "256color" ? "256color" : "truecolor";
	const custom = (hex: string | undefined, text: string) =>
		hex === undefined ? undefined : paintForeground(hex, text, mode);
	const painters: Partial<Record<ColorToken, (text: string) => string>> = {
		border: (text) => custom(palette.border, text) ?? theme.fg("borderMuted", text),
		windowTitle: (text) => custom(palette.windowTitle, text) ?? theme.fg("mdHeading", text),
		sectionTitle: (text) => custom(palette.sectionTitle, text) ?? theme.fg("mdHeading", text),
		// One `content` colour covers values, labels and dimmed names alike.
		text: (text) => custom(palette.content, text) ?? theme.fg("text", text),
		muted: (text) => custom(palette.content, text) ?? theme.fg("muted", text),
		dim: (text) => custom(palette.content, text) ?? theme.fg("dim", text),
	};
	return {
		fg: (token, text) => painters[token]?.(text) ?? theme.fg(token, text),
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
	/**
	 * Short trailing badge that survives truncation, e.g. the thinking level after
	 * the model name. Rendered muted, one space after the value.
	 */
	suffix?: string;
}

export interface ResourceSection {
	title: string;
	names: readonly string[];
	/** One name per line instead of the comma-wrapped flow (used by Extensions). */
	stacked?: boolean;
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
	const border = (ch: string) => painter.fg("border", ch);

	let top: string;
	if (title && contentWidth >= 6) {
		const styled = painter.bold(painter.fg("windowTitle", ` ${title} `));
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
		rows.push(border(style.v) + " " + truncateToWidth(line, contentWidth, "...", true) + " " + border(style.v));
	}
	if (targetBody !== undefined) {
		const blank = border(style.v) + " ".repeat(contentWidth + 2) + border(style.v);
		while (rows.length < targetBody) rows.push(blank);
	}

	const bottom = border(style.bl) + border(style.h.repeat(inner)) + border(style.br);
	return [truncateToWidth(top, w, ""), ...rows, bottom];
}

/**
 * One `[Label] value` row: the bracketed label reuses the `[Context]` heading
 * style, the suffix keeps its own width budget so a long value degrades to an
 * ellipsis instead of pushing the thinking level off the row.
 *
 * Shared by `infoBox` (the pre-tree info card) and the tree renderer's `inline`
 * content specs, so both shapes stay identical.
 */
export function formatInfoRow(row: InfoRow, contentWidth: number, painter: Painter): string {
	const label = painter.bold(painter.fg("sectionTitle", `[${row.label}]`));
	const labelWidth = visibleWidth(label);
	const suffix = row.suffix ? painter.fg("muted", row.suffix) : "";
	const suffixWidth = suffix ? visibleWidth(suffix) + 1 : 0;
	const valueWidth = Math.max(1, contentWidth - labelWidth - 1 - suffixWidth);
	const value = painter.fg("text", truncateToWidth(row.value, valueWidth, "..."));
	return `${label} ${value}${suffix ? ` ${suffix}` : ""}`;
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
	const body = rows.map((row) => formatInfoRow(row, contentWidth, painter));
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
		current = prefix + truncateToWidth(name, avail - visibleWidth(prefix), "...");
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
	return room <= 0 ? truncateToWidth(line, width, "...") : `${truncateToWidth(line, room, "")}, ...`;
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

/**
 * One name per line, 2-space indent. When the row budget runs out the tail
 * collapses to `, ...` (or a bare `...` line) so the cut is visible.
 */
export function stackNames(names: readonly string[], width: number, maxLines = Number.POSITIVE_INFINITY): string[] {
	const indent = "  ";
	const avail = Math.max(4, Math.floor(width));
	const limit = Math.max(1, Math.floor(maxLines));
	const overflow = names.length > limit;
	const shown = overflow ? limit - 1 : names.length;
	const out = names.slice(0, shown).map((name) => indent + truncateToWidth(name, avail - indent.length, "..."));
	if (!overflow) return out;
	if (shown === 0) {
		const first = indent + truncateToWidth(names[0] ?? "", Math.max(1, avail - indent.length - 5), "");
		out.push(appendEllipsis(first, avail));
	} else {
		out.push(`${indent}...`);
	}
	return out;
}

/** `[Context]` heading plus dim, wrapped (or stacked), 2-space-indented names. */
export function resourceSection(
	title: string,
	names: readonly string[],
	width: number,
	painter: Painter,
	maxLines = Number.POSITIVE_INFINITY,
	stacked = false,
): string[] {
	const out = [painter.bold(painter.fg("sectionTitle", `[${title}]`))];
	if (names.length === 0) {
		out.push(painter.fg("dim", "  (none)"));
		return out;
	}
	const lines = stacked ? stackNames(names, width, maxLines) : wrapNames(names, width, maxLines);
	for (const line of lines) out.push(painter.fg("dim", line));
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
		if (section.names.length === 0) return 1;
		const lines = section.stacked
			? section.names.length
			: wrapNames(section.names, contentWidth).length;
		return cap === undefined ? lines : Math.min(lines, Math.max(1, cap));
	});
	const bodyBudget = finiteRows ? Math.max(kept.length, usableRows - kept.length) : Number.MAX_SAFE_INTEGER;
	const caps = finiteRows ? distributeLines(needs, bodyBudget) : needs;

	const body: string[] = [];
	kept.forEach((section, index) => {
		body.push(...resourceSection(section.title, section.names, contentWidth, painter, caps[index] ?? 1, section.stacked));
	});
	return panel(title, body, width, painter, { fillTo: totalRows, style });
}
