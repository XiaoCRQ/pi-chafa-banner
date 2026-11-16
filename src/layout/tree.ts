/**
 * The recursive splash layout tree.
 *
 * A splash is a tree of three node kinds — `chafa` (a picture canvas), `window`
 * (a bordered box of content specs) and `layout` (a group that splits its box
 * between its children by weight). Geometry is solved from the config alone
 * (`width`/`height`/`gap`/weights), never from the terminal: the chafa pipeline
 * has to know the canvas size while it is pre-rendering frames, long before
 * `render(width)` runs. A narrower terminal clips the finished frames; it never
 * changes their size.
 *
 * Everything in this module is pure. Structural problems throw `LayoutError`
 * with a JSON-ish node path (`root.0.1`) so the renderer can show an error card.
 */

import { autoHeightFor } from "../config/schema.ts";
import { sanitizeChafaArgs, splitArgs } from "../pipeline/args.ts";

export type LayoutMode = "horizontal" | "vertical";

/** `inline` renders `[Title] value`; `outline` puts the title on its own line. */
export type ContentFlavor = "inline" | "outline";

export interface ContentSpec {
	type: ContentFlavor;
	title?: string;
	/** Provider name (`version`, `context`, …) or a literal string. */
	content: string;
	/** One entry per line (used by long name lists such as Extensions). */
	stacked?: boolean;
}

export interface ChafaNode {
	type: "chafa";
	weight: number;
	/** Per-node image override; defaults to the splash's gif. */
	img?: string;
	/** Extra chafa arguments, shell-split like `image.chafa`. */
	args?: string;
}

export interface LayoutGroup {
	type: "layout";
	weight: number;
	mode: LayoutMode;
	children: LayoutNode[];
}

export interface WindowNode {
	type: "window";
	weight: number;
	title?: string;
	content: ContentSpec[];
}

export type LayoutNode = ChafaNode | LayoutGroup | WindowNode;

/**
 * Blank space between siblings, per axis. A character cell is about half as wide
 * as it is tall, so a single number cannot describe both directions.
 */
export interface SplashGap {
	/** Blank columns between siblings of a horizontal group. */
	width: number;
	/** Blank rows between siblings of a vertical group. */
	height: number;
}

/** Clamped, integer gap for one axis; tolerant of hand-built settings. */
export function gapOn(axis: "width" | "height", gap: SplashGap): number {
	return Math.max(0, Math.floor(axis === "width" ? gap.width : gap.height));
}

/** The dimensions the tree is solved against (terminal size comes in later). */
export interface SplashSettings {
	width: number;
	/** Height floor; `null` means "as tall as the content needs". */
	height: number | null;
	gap: SplashGap;
	variableWidth: boolean;
	variableHeight: boolean;
	compactWidth: number;
}

export interface Box {
	width: number;
	height: number;
}

/** Natural size of a subtree. `min` is the hard floor, `pref` the wanted size. */
export interface Measure {
	minWidth: number;
	minHeight: number;
	prefWidth: number;
	prefHeight: number;
	/** True when the subtree contains a window and can therefore absorb slack. */
	flexible: boolean;
}

/**
 * One chafa canvas to pre-render.
 *
 * `key` and `path` are both the node path (e.g. `root.0.0`): the path is the
 * stable identity of a canvas across config reloads, and `key` is the name the
 * frame cache uses. `image` is the resolved gif path (node `img` or the splash's
 * `image.path`); `args` is the sanitized argv for this canvas.
 */
export interface ChafaPlan {
	key: string;
	path: string;
	image: string;
	args: string[];
	width: number;
	height: number;
}

/**
 * Raised when the tree cannot be laid out: a malformed node, or a box that is
 * smaller than a child's minimum. `nodePath` points at the offending node.
 */
export class LayoutError extends Error {
	constructor(
		readonly nodePath: string,
		message: string,
	) {
		super(nodePath ? `${nodePath}: ${message}` : message);
		this.name = "LayoutError";
	}
}

/**
 * Smallest box each node kind can occupy.
 *
 * `layout` is derived from its children (sum/max plus gaps), so its entry is
 * only here so lookups by node kind stay total.
 */
export const NODE_MIN = {
	// A canvas is allowed to shrink to two rows so that a short terminal (16 rows
	// plus a status line) can still fund a usable info card; `allocate()` takes
	// those cells from the artwork, not from the window.
	chafa: { width: 8, height: 2 },
	window: { width: 12, height: 3 },
	layout: { width: 0, height: 0 },
} as const;

/**
 * Replace control characters (CR/LF, tabs, ESC, DEL/C1) with spaces.
 *
 * Every rendered row is a single string with no embedded line breaks, and every
 * width calculation counts a control character as one column while a terminal
 * may expand (tab) or reset (ESC) it. Flattening at the door keeps the row
 * accounting honest and stops a config value from smuggling ANSI escapes in.
 */
export function flattenText(value: string): string {
	return value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ");
}

/**
 * Default splash tree — declared in `config/schema.ts` (next to `DEFAULT_FILE`)
 * and re-exported here so layout consumers keep one import path.
 */
export { DEFAULT_LAYOUT } from "../config/schema.ts";

/** `[]` → `"root"`, `[0, 1]` → `"root.0.1"`. */
export function nodePathOf(indexes: readonly number[]): string {
	return indexes.length === 0 ? "root" : `root.${indexes.join(".")}`;
}

/** Deep copy of a tree (config parsing and the legacy translation never mutate). */
export function cloneLayout(node: LayoutNode): LayoutNode {
	if (node.type === "layout") {
		return { ...node, children: node.children.map(cloneLayout) };
	}
	if (node.type === "window") {
		return { ...node, content: node.content.map((spec) => ({ ...spec })) };
	}
	return { ...node };
}

/** Positive, finite weight; anything else means "default 1". */
export function weightOf(node: LayoutNode): number {
	return Number.isFinite(node.weight) && node.weight > 0 ? node.weight : 1;
}

/**
 * Largest-remainder apportionment: integer shares that sum to exactly
 * `available`, proportional to `weights`. Ties break to the lower index, so the
 * result is deterministic.
 */
export function proportionalShares(available: number, weights: readonly number[]): number[] {
	const count = weights.length;
	if (count === 0) return [];
	const total = weights.reduce((sum, weight) => sum + weight, 0);
	const shares = weights.map((weight) => Math.floor((available * weight) / total));
	let remainder = available - shares.reduce((sum, share) => sum + share, 0);
	const fractions = weights
		.map((weight, index) => ({ index, fraction: (available * weight) / total - Math.floor((available * weight) / total) }))
		.sort((a, b) => b.fraction - a.fraction || a.index - b.index);
	for (let step = 0; remainder > 0; step++) {
		const target = fractions[step % count];
		if (!target) break;
		shares[target.index] = (shares[target.index] ?? 0) + 1;
		remainder -= 1;
	}
	return shares;
}

/**
 * Guard: only the three node kinds exist, and groups have children.
 *
 * Structural mistakes are user errors, so they throw instead of degrading to a
 * default node: the renderer turns the error into a `LAYOUT ERROR` card. Both
 * `planChafaNodes` and `distribute` run this check, so a malformed tree is
 * reported no matter which entry point the caller reaches first.
 */
export function assertNode(node: LayoutNode, path: string): void {
	if (typeof node !== "object" || node === null) {
		throw new LayoutError(path, "expected an object");
	}
	// A missing weight means "1"; an explicit non-positive or non-numeric one
	// is a config mistake the error card has to show.
	if (node.weight !== undefined && (!Number.isFinite(node.weight) || node.weight <= 0)) {
		throw new LayoutError(path, "weight must be a positive number");
	}
	if (node.type === "chafa") return;
	if (node.type === "layout") {
		if (!Array.isArray(node.children) || node.children.length === 0) {
			throw new LayoutError(path, "layout needs at least one child");
		}
		if (node.mode !== "horizontal" && node.mode !== "vertical") {
			throw new LayoutError(path, 'mode must be "horizontal" or "vertical"');
		}
		return;
	}
	if (node.type === "window") {
		if (!Array.isArray(node.content)) {
			throw new LayoutError(path, "window needs a content array");
		}
		node.content.forEach((spec, index) => {
			if (typeof spec !== "object" || spec === null || (spec.type !== "inline" && spec.type !== "outline")) {
				throw new LayoutError(`${path}.content[${index}]`, 'type must be "inline" or "outline"');
			}
			if (typeof spec.content !== "string") {
				throw new LayoutError(`${path}.content[${index}].content`, "expected a string");
			}
		});
		return;
	}
	throw new LayoutError(
		path,
		`expected one of chafa, layout, window; got ${JSON.stringify((node as { type?: unknown }).type)}`,
	);
}

/**
 * Validate a whole subtree, parent before children.
 *
 * Callers that need geometry (rather than just the canvas plans) must run this
 * before touching children: a node with an unknown `type` has no `children`
 * array, so measuring first would crash on it instead of reporting it.
 */
export function assertTree(node: LayoutNode, indexes: readonly number[] = []): void {
	const path = nodePathOf(indexes);
	assertNode(node, path);
	if (node.type !== "layout") return;
	node.children.forEach((child, index) => assertTree(child, [...indexes, index]));
}

/** Sanitized argv for one chafa node: the global arguments plus its own. */
function chafaArgsFor(node: ChafaNode, chafaArgs: readonly string[]): string[] {
	const extra = node.args === undefined ? [] : splitArgs(node.args);
	return sanitizeChafaArgs([...chafaArgs, ...extra]);
}

/**
 * Nominal geometry of every chafa canvas, solved from config + weights + gap.
 *
 * Heights use the generic character-cell aspect ratio (`autoHeightFor`); the
 * session replaces them with the gif's real aspect once ffprobe has run. Widths
 * are split by weight inside every horizontal group, and a canvas is never
 * planned below `NODE_MIN.chafa`.
 */
export function planChafaNodes(
	root: LayoutNode,
	settings: SplashSettings,
	gifPath: string | undefined,
	chafaArgs: readonly string[],
): ChafaPlan[] {
	const plans: ChafaPlan[] = [];
	const gap = gapOn("width", settings.gap);
	const walk = (node: LayoutNode, indexes: readonly number[], width: number): void => {
		const path = nodePathOf(indexes);
		assertNode(node, path);
		if (node.type === "chafa") {
			const canvasWidth = Math.max(NODE_MIN.chafa.width, Math.floor(width));
			plans.push({
				key: path,
				path,
				image: node.img ?? gifPath ?? "",
				args: chafaArgsFor(node, chafaArgs),
				width: canvasWidth,
				height: autoHeightFor(canvasWidth),
			});
			return;
		}
		if (node.type === "window") return;
		const count = node.children.length;
		if (node.mode === "vertical") {
			node.children.forEach((child, index) => walk(child, [...indexes, index], width));
			return;
		}
		const available = Math.max(0, Math.floor(width) - gap * (count - 1));
		const shares = proportionalShares(available, node.children.map(weightOf));
		node.children.forEach((child, index) => walk(child, [...indexes, index], shares[index] ?? 0));
	};
	walk(root, [], settings.width);
	return plans;
}

/**
 * Re-plan every canvas for a box that is not the configured width.
 *
 * The terminal decides how wide the splash may be, but frames are cached per
 * `width x height` grid, so a width change has to reach the frame pipeline. The
 * height keeps the aspect ratio already probed for that node (`basePlans`), so a
 * narrower box yields a proportionally shorter picture instead of a cropped or
 * stretched one.
 */
export function plansForWidth(
	root: LayoutNode,
	settings: SplashSettings,
	width: number,
	basePlans: readonly ChafaPlan[],
	gifPath: string | undefined,
	chafaArgs: readonly string[],
): ChafaPlan[] {
	const target = Math.max(1, Math.floor(width));
	const nominal = planChafaNodes(root, { ...settings, width: target }, gifPath, chafaArgs);
	return nominal.map((plan) => {
		const base = planForPath(basePlans, plan.path);
		const ratio = base !== undefined && base.width > 0 ? base.height / base.width : 0;
		if (!(ratio > 0)) return plan;
		const height = Math.max(NODE_MIN.chafa.height, Math.round(plan.width * ratio));
		return height === plan.height ? plan : { ...plan, height };
	});
}

/** Plan for one node path, if the tree contains a chafa node there. */
export function planForPath(plans: readonly ChafaPlan[], nodePath: string): ChafaPlan | undefined {
	return plans.find((plan) => plan.path === nodePath);
}
