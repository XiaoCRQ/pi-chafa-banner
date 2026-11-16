/**
 * The recursive renderer: layout tree + solved boxes -> rows of styled text.
 *
 * `renderSplash()` is the only entry point that knows about the terminal. It
 * derives the root box from the configuration (`width`/`height`, the two
 * `variable*` flags), caps it with the space pi actually has, and then hands the
 * work to `renderNode()`, which is a pure function of `(node, box, context)`.
 *
 * Consequences worth keeping in mind:
 *
 *   - a narrower terminal can never change a chafa canvas size: frames are
 *     pre-rendered from the config alone, so an overflowing canvas is clipped
 *     here (`cropFrame`, top-down);
 *   - nothing in this module spawns a process or touches the filesystem, because
 *     `render(width)` inside pi has to stay synchronous;
 *   - `renderSplash()` never throws. A structural mistake or a box that cannot
 *     fit its children becomes a `LAYOUT ERROR` card, which is the whole point
 *     of the tree rewrite: errors must be visible, not silently degraded away.
 */

import { resolveContent, type ContentContext } from "../content.ts";
import type { FrameSet } from "../frames.ts";
import { LIMITS } from "../config/schema.ts";
import { padVisible, sliceVisible, stripAnsi, truncateToWidth, visibleWidth } from "../text.ts";
import { formatInfoRow, panel, resourceSection, type Painter } from "./box.ts";
import { centerBlock, compactSplash } from "./compose.ts";
import { distribute, measureTree } from "./measure.ts";
import { splashRows } from "./metrics.ts";
import {
	assertNode,
	assertTree,
	flattenText,
	gapOn,
	LayoutError,
	NODE_MIN,
	nodePathOf,
	planForPath,
	plansForWidth,
	type Box,
	type ChafaPlan,
	type ContentSpec,
	type LayoutGroup,
	type LayoutNode,
	type Measure,
	type SplashSettings,
	type WindowNode,
} from "./tree.ts";

export interface RenderContext {
	painter: Painter;
	plans: readonly ChafaPlan[];
	/** Pre-rendered canvas per plan key; a missing entry means "still building". */
	frames: Map<string, FrameSet>;
	frameIndex: number;
	content: ContentContext;
	settings: SplashSettings;
	status?: string;
	/** Fallback artwork and global chafa arguments, so a width change can re-plan. */
	gifPath?: string;
	chafaArgs?: readonly string[];
	/** The width `plans` (and therefore `frames`) were solved for. */
	planWidth?: number;
	/**
	 * Called when the box needs canvases the frames were not built for. The
	 * session answers by rebuilding them off the render path; the cached frames
	 * are cropped in the meantime.
	 */
	onWidth?: (width: number) => void;
}

// ---------------------------------------------------------------------------
// content
// ---------------------------------------------------------------------------

/** `[Title]` fallback for a spec that came in without one. */
function titleOf(spec: ContentSpec): string {
	const explicit = flattenText(spec.title ?? "").trim();
	if (explicit) return explicit;
	const name = flattenText(spec.content).trim();
	return name === "" ? "" : name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Provider result, flattened to single-line values.
 *
 * The config parser already sanitizes its strings, but trees are also built by
 * tests, the v1 translator and third parties; a `\n` reaching a row array would
 * break the "one string = one row" invariant and the terminal width accounting.
 */
function resolveRow(
	spec: ContentSpec,
	ctx: RenderContext,
): { value: string; suffix?: string; names?: readonly string[] } {
	const resolved = resolveContent(flattenText(spec.content), ctx.content);
	const out: { value: string; suffix?: string; names?: readonly string[] } = {
		value: flattenText(resolved.value),
	};
	if (resolved.suffix !== undefined) out.suffix = flattenText(resolved.suffix);
	if (resolved.names) out.names = resolved.names.map((name) => flattenText(name));
	return out;
}

/**
 * Body rows of a window at a given content width (the box minus its borders and
 * the one-column padding `panel()` adds on each side).
 *
 * `inline` keeps label and value on one row, `outline` puts the heading first —
 * the same shapes the hand-written info card and RESOURCES panel used, so an
 * untouched config looks untouched.
 */
/** One rendered row; its own indentation seeds the overflow marker. */
interface BodyLine {
	text: string;
}

function contentBody(node: WindowNode, inner: number, ctx: RenderContext): BodyLine[] {
	const lines: BodyLine[] = [];
	for (const spec of node.content) {
		const resolved = resolveRow(spec, ctx);
		const title = titleOf(spec);
		if (spec.type === "inline") {
			lines.push({ text: formatInfoRow({ label: title, value: resolved.value, suffix: resolved.suffix }, inner, ctx.painter) });
			continue;
		}
		if (resolved.names) {
			// `resourceSection` already handles the `[Heading]` row, the 2-space
			// indent, comma wrapping and one-per-line stacking.
			const rows = resourceSection(title, resolved.names, inner, ctx.painter, Number.POSITIVE_INFINITY, spec.stacked === true);
			rows.forEach((text) => lines.push({ text }));
			continue;
		}
		lines.push({ text: ctx.painter.bold(ctx.painter.fg("sectionTitle", `[${title}]`)) });
		const suffix = resolved.suffix ? ` ${ctx.painter.fg("muted", resolved.suffix)}` : "";
		lines.push({ text: ctx.painter.fg("text", `  ${resolved.value}${suffix}`) });
	}
	return lines;
}

/**
 * The row that stands in for the cut. It keeps the indentation of the row it
 * replaces — `...` for a heading (and an inline field, which is a heading too),
 * `  ...` for an item, so nothing shifts a column at the cut.
 */
function overflowMark(dropped: BodyLine | undefined, inner: number, ctx: RenderContext): string {
	const indent = dropped ? leadingSpaces(stripAnsi(dropped.text)) : 0;
	return truncateToWidth(ctx.painter.fg("dim", `${" ".repeat(Math.min(indent, 4))}...`), inner);
}

/** Visible indentation of a rendered row. */
function leadingSpaces(text: string): number {
	const match = /^ */.exec(text);
	return match ? match[0].length : 0;
}

/** Width the content wants before any wrapping happens (borders excluded). */
function naturalWidth(node: WindowNode, ctx: RenderContext): number {
	let widest = 0;
	for (const spec of node.content) {
		const resolved = resolveRow(spec, ctx);
		const heading = visibleWidth(`[${titleOf(spec)}]`);
		const suffix = resolved.suffix ? 1 + visibleWidth(resolved.suffix) : 0;
		if (spec.type === "inline") {
			widest = Math.max(widest, heading + 1 + visibleWidth(resolved.value) + suffix);
			continue;
		}
		widest = Math.max(widest, heading);
		if (resolved.names) {
			const body = spec.stacked
				? resolved.names.reduce((max, name) => Math.max(max, visibleWidth(name)), 0) + 2
				: visibleWidth(resolved.names.join(", ")) + 2;
			widest = Math.max(widest, body);
		} else {
			widest = Math.max(widest, visibleWidth(`  ${resolved.value}`) + suffix);
		}
	}
	return widest;
}

/**
 * Content-driven size of a window, measured at a given box width.
 *
 * `width` is the *outer* box width; body text has `width - 4` columns to work
 * with. `prefWidth` deliberately ignores the measured width (it is the width the
 * content wants), which is what `variableWidth` grows the root with.
 */
export function measureContent(node: WindowNode, width: number, ctx: RenderContext): Measure {
	const boxWidth = Math.max(1, Math.floor(width));
	const inner = Math.max(1, boxWidth - 4);
	const body = contentBody(node, inner, ctx);
	const natural = naturalWidth(node, ctx);
	return {
		minWidth: NODE_MIN.window.width,
		minHeight: NODE_MIN.window.height,
		prefWidth: Math.max(NODE_MIN.window.width, Math.min(LIMITS.layoutWidth.max, natural + 4)),
		prefHeight: Math.max(NODE_MIN.window.height, body.length + 2),
		flexible: true,
	};
}

// ---------------------------------------------------------------------------
// leaves
// ---------------------------------------------------------------------------

/**
 * Clip chafa output to `rows` lines from the top (faces live there) and center
 * each line inside `width`. The canvas itself is never rescaled: its size comes
 * from the config, so a narrow terminal crops instead of re-rendering.
 */
export function cropFrame(frame: readonly string[], width: number, rows: number): string[] {
	const limit = Math.max(0, Math.floor(rows));
	const columns = Math.max(0, Math.floor(width));
	const out: string[] = [];
	for (const line of frame.slice(0, limit)) {
		const trimmed = truncateToWidth(line, columns, "");
		const pad = Math.max(0, Math.floor((columns - visibleWidth(trimmed)) / 2));
		out.push(" ".repeat(pad) + trimmed);
	}
	return out;
}

/**
 * "No picture yet" card: the note sits in an `IMAGE` box at the top of the
 * canvas box so the rows below it keep their place when the frames arrive.
 */
export function placeholderCard(
	painter: Painter,
	status: string | undefined,
	width: number,
	height: number,
): string[] {
	const note = status
		? `unavailable: ${truncateToWidth(status, Math.max(8, width - 4), "...")}`
		: "rendering chafa frames…";
	const box = panel("IMAGE", [painter.fg("dim", note)], width, painter);
	const limit = Math.max(0, Math.floor(height));
	// Too short for a bordered card (a 2-row canvas on a tiny terminal): keep the
	// note itself instead of a box whose bottom border is cut off.
	if (limit < 3) {
		const columns = Math.max(1, Math.floor(width));
		const line = padVisible(truncateToWidth(painter.fg("dim", note), columns, "..."), columns);
		return Array.from({ length: limit }, (_unused, row) => (row === 0 ? line : ""));
	}
	if (box.length >= limit) return box.slice(0, limit);
	return [...box, ...Array.from({ length: limit - box.length }, () => "")];
}

function renderChafa(path: string, box: Box, ctx: RenderContext): string[] {
	const plan = planForPath(ctx.plans, path);
	const frames = ctx.frames.get(plan?.key ?? path);
	if (!frames || frames.frames.length === 0) {
		return placeholderCard(ctx.painter, ctx.status, box.width, box.height);
	}
	const count = frames.frames.length;
	const index = ((Math.floor(ctx.frameIndex) % count) + count) % count;
	return cropFrame(frames.frames[index] ?? [], box.width, box.height);
}

function renderWindow(node: WindowNode, box: Box, ctx: RenderContext): string[] {
	const width = Math.max(0, Math.floor(box.width));
	const height = Math.max(0, Math.floor(box.height));
	const inner = Math.max(0, width - 4);
	const budget = Math.max(0, height - 2);
	// Two overflow rules, both visible instead of spilling over the border: a row
	// that is too wide ends in `...`, and content taller than the box keeps its
	// first `budget - 1` rows and marks the cut on the last one.
	//
	// `variableHeight` turns the second rule off: the box is supposed to grow
	// until everything fits, so if the terminal still forces a cut we clip
	// silently rather than claim the content ended there.
	const full = contentBody(node, inner, ctx);
	const body = full.map((line) => truncateToWidth(line.text, inner, "..."));
	const clipped = body.length > budget;
	let fitted = body;
	if (clipped) {
		if (ctx.settings.variableHeight) fitted = body.slice(0, budget);
		else if (budget === 0) fitted = [];
		else fitted = [...body.slice(0, budget - 1), overflowMark(full[budget - 1], inner, ctx)];
	}
	return panel(flattenText(node.title ?? "WINDOW"), fitted, width, ctx.painter, { fillTo: height });
}

// ---------------------------------------------------------------------------
// recursive layout
// ---------------------------------------------------------------------------

/** `"root.0.1"` -> `[0, 1]`, so `distribute` can talk about global node paths. */
function indexesOfPath(path: string): number[] {
	if (path === "root") return [];
	return path
		.split(".")
		.slice(1)
		.map((part) => Number(part))
		.filter((value) => Number.isFinite(value));
}

function renderGroup(node: LayoutGroup, path: string, box: Box, ctx: RenderContext): string[] {
	// Columns between side-by-side children, rows between stacked ones: the two
	// gaps are configured separately because a cell is not square.
	const gap = gapOn(node.mode === "horizontal" ? "width" : "height", ctx.settings.gap);
	// The prefix keeps every box key a global node path (`root.0.1`), which is
	// also what chafa plans and the frame map are keyed by.
	const boxes = distribute(
		node,
		box,
		ctx.settings,
		ctx.plans,
		(window, width) => measureContent(window, width, ctx),
		indexesOfPath(path),
	);
	const children = node.children.map((child, index) => {
		const childPath = `${path}.${index}`;
		const childBox = boxes.get(childPath) ?? { width: 0, height: 0 };
		return renderNode(child, childPath, childBox, ctx);
	});

	if (node.mode === "horizontal") {
		const separator = " ".repeat(gap);
		const rows = children.reduce((max, lines) => Math.max(max, lines.length), 0);
		const out: string[] = [];
		for (let row = 0; row < rows; row++) {
			out.push(children.map((lines) => lines[row] ?? "").join(separator));
		}
		return out;
	}

	const blank = " ".repeat(Math.max(0, Math.floor(box.width)));
	const out: string[] = [];
	children.forEach((lines, index) => {
		if (index > 0) for (let row = 0; row < gap; row++) out.push(blank);
		out.push(...lines);
	});
	return out;
}

/** Exactly `box.height` rows, each exactly `box.width` columns. */
function fitBox(lines: readonly string[], box: Box): string[] {
	const width = Math.max(0, Math.floor(box.width));
	const height = Math.max(0, Math.floor(box.height));
	const out: string[] = [];
	for (let row = 0; row < height; row++) {
		out.push(padVisible(truncateToWidth(lines[row] ?? "", width, ""), width));
	}
	return out;
}

/**
 * Render one subtree into a box. The result is always exactly `box.height` rows
 * of exactly `box.width` columns, so a parent can concatenate children blindly.
 *
 * Throws `LayoutError` when the box cannot host the subtree; `renderSplash()`
 * turns that into the error card.
 */
export function renderNode(node: LayoutNode, path: string, box: Box, ctx: RenderContext): string[] {
	assertNode(node, path);
	const target = {
		width: Math.max(0, Math.floor(box.width)),
		height: Math.max(0, Math.floor(box.height)),
	};
	if (target.width === 0 || target.height === 0) {
		return Array.from({ length: target.height }, () => "");
	}
	let lines: string[];
	if (node.type === "chafa") lines = renderChafa(path, target, ctx);
	else if (node.type === "window") lines = renderWindow(node, target, ctx);
	else lines = renderGroup(node, path, target, ctx);
	return fitBox(lines, target);
}

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

/**
 * `root.0.1` (node path) -> `layout.children[0].children[1]` (JSON path).
 *
 * The layout error card must point at the file the user has to edit, not at an
 * internal index trail.
 */
export function configPathOf(nodePath: string): string {
	if (!nodePath || nodePath === "root") return "layout";
	let out = "layout";
	for (const part of nodePath.split(".").slice(1)) {
		out += /^\d+$/.test(part) ? `.children[${part}]` : `.${part}`;
	}
	return out;
}

function errorMessage(error: unknown): string {
	if (error instanceof LayoutError) {
		const prefix = `${error.nodePath}: `;
		const detail = error.message.startsWith(prefix) ? error.message.slice(prefix.length) : error.message;
		return `${configPathOf(error.nodePath)}: ${detail}`;
	}
	return `unexpected error: ${error instanceof Error ? error.message : String(error)}`;
}

/** Break a plain-text message into rows of at most `width` columns. */
function wrapText(text: string, width: number): string[] {
	const limit = Math.max(1, Math.floor(width));
	const out: string[] = [];
	let rest = text;
	while (visibleWidth(rest) > limit) {
		const slice = sliceVisible(rest, 0, limit);
		// Break at the last space so a JSON path or a word stays whole; only when
		// there is no space, fall back to the last `:`/`,` so `layout.children[1]`
		// does not become `layout.children[1` + `].type`.
		let cut = slice.lastIndexOf(" ");
		let skip = 1;
		if (cut <= 0) {
			const punctuation = Math.max(slice.lastIndexOf(":"), slice.lastIndexOf(","));
			if (punctuation > 0) {
				cut = punctuation + 1;
				skip = 0;
			}
		}
		if (cut > 0) {
			out.push(slice.slice(0, cut));
			rest = rest.slice(cut + skip);
			continue;
		}
		out.push(slice);
		rest = rest.slice(slice.length);
	}
	out.push(rest);
	return out;
}

/**
 * The `LAYOUT ERROR` card. `message` is one line per problem (a config path and
 * the reason); long lines are wrapped rather than lost, and every row is clipped
 * to `width` so the caller can place it in any terminal.
 *
 * `maxRows` keeps the card inside the document viewport: the message is shortened
 * with a trailing `…` instead of pushing pi's editor off screen.
 */
export function renderLayoutError(message: string, width: number, painter: Painter, maxRows?: number): string[] {
	const w = Math.max(1, Math.floor(width));
	const inner = Math.max(1, w - 4);
	let body: string[] = [];
	for (const paragraph of message.split("\n")) {
		if (paragraph === "") {
			body.push("");
			continue;
		}
		body.push(...wrapText(paragraph, inner).map((line) => painter.fg("warning", line)));
	}
	if (maxRows !== undefined) {
		const limit = Math.max(3, Math.floor(maxRows));
		const allowed = Math.max(1, limit - 2);
		if (body.length > allowed) {
			body = [...body.slice(0, Math.max(0, allowed - 1)), painter.fg("dim", "...")];
		}
	}
	const card = panel("LAYOUT ERROR", body, w, painter);
	return card.map((line) => truncateToWidth(line, w, ""));
}

// ---------------------------------------------------------------------------
// root
// ---------------------------------------------------------------------------

/**
 * Render the whole splash into `available` (terminal columns x rows).
 *
 * Root size, exactly as documented in the config contract:
 *
 *   W = variableWidth  ? min(max(width,  natural content width), columns)
 *                      : min(width, columns)
 *   H = variableHeight ? min(max(height, natural content height), splash rows)
 *                      : min(height, splash rows)
 *
 * `splashRows()` (and one row for the status line, when present) is the document
 * viewport, so the splash never pushes pi's editor around. Narrow terminals keep
 * their three-line `compactSplash`; anything else that cannot be laid out ends in
 * the error card, never in an exception or a quietly different layout.
 */
/**
 * Root height: `height: null` ("auto") is content-driven, a number is a floor
 * that the content may raise (`variableHeight`) — never a ceiling that silently
 * hides rows. The terminal viewport is the only real cap.
 */
function heightFor(settings: SplashSettings, natural: number, budget: number): number {
	const want = settings.height === null ? natural : Math.max(settings.height, natural);
	const target = settings.variableHeight ? want : (settings.height ?? natural);
	return Math.max(1, Math.min(target, budget));
}

export function renderSplash(root: LayoutNode, ctx: RenderContext, available: Box): string[] {
	const cols = Math.max(1, Math.floor(Number.isFinite(available.width) ? available.width : 80));
	const terminalRows = Math.max(1, Math.floor(Number.isFinite(available.height) ? available.height : 40));
	const settings = ctx.settings;
	const place = (lines: string[]) => centerBlock(lines, cols).map((line) => truncateToWidth(line, cols, ""));

	try {
		if (cols < settings.compactWidth) {
			const lines = compactSplash(cols, ctx.painter, {
				version: ctx.content.version,
				model: ctx.content.model,
				thinking: ctx.content.thinking,
			});
			// Even three lines have room for the reason frames are unavailable.
			if (ctx.status) lines.push(ctx.painter.fg("dim", flattenText(ctx.status)));
			return place(lines);
		}

		// Structure before sizes: a malformed node has no `children`, so measuring
		// it first would crash instead of reporting the offending path.
		assertTree(root);
		const statusRows = ctx.status ? 1 : 0;
		const budget = Math.max(1, splashRows(terminalRows) - statusRows);
		const contentNeed = (node: WindowNode, width: number) => measureContent(node, width, ctx);
		const configured = Math.max(1, Math.min(settings.width, cols));
		const atConfigured = { ...settings, width: configured };
		const first = measureTree(root, atConfigured, ctx.plans, contentNeed);
		const width = settings.variableWidth
			? Math.max(configured, Math.min(first.prefWidth, cols))
			: configured;
		// The terminal decides how wide the splash may be. A box narrower than the
		// configured width re-plans the canvases at that width (keeping the probed
		// aspect ratio), so the picture scales down instead of being cropped; the
		// frames for that grid arrive through `onWidth`, cached ones show meanwhile.
		let localSettings = atConfigured;
		let plans = ctx.plans;
		let need = first;
		if (width !== settings.width) {
			localSettings = { ...settings, width };
			plans = plansForWidth(root, settings, width, ctx.plans, ctx.gifPath, ctx.chafaArgs ?? []);
			// Canvases changed size, so every height preference has to be re-measured.
			need = measureTree(root, localSettings, plans, contentNeed);
		}
		const height = heightFor(localSettings, need.prefHeight, budget);
		if (plans.length > 0 && width !== (ctx.planWidth ?? plans[0]?.width)) ctx.onWidth?.(width);
		const box: Box = { width, height };
		const localCtx = plans === ctx.plans && localSettings === ctx.settings ? ctx : { ...ctx, plans, settings: localSettings };
		const lines = renderNode(root, nodePathOf([]), box, localCtx);
		if (ctx.status) {
			lines.push(padVisible(truncateToWidth(ctx.painter.fg("dim", ctx.status), box.width, "..."), box.width));
		}
		return place(lines);
	} catch (error) {
		const cardWidth = Math.max(1, Math.min(cols, Math.max(20, settings.width)));
		const room = Math.max(3, splashRows(terminalRows) - (ctx.status ? 1 : 0));
		return place(renderLayoutError(errorMessage(error), cardWidth, ctx.painter, room));
	}
}
