/**
 * Parsing of the recursive `layout` subtree from `pi-chafa-banner.json`.
 *
 * Two kinds of mistakes, handled differently on purpose:
 *
 *   - missing or mistyped *optional* detail (no `weight`, a non-string title,
 *     a `stacked` flag that is not a boolean) gets a sensible default and a
 *     warning, because the node still means something;
 *   - structural mistakes (unknown `type`, a group without children, a window
 *     without content, a non-positive weight, a non-object node) are returned as
 *     an error string, because the splash must show a `LAYOUT ERROR` card rather
 *     than quietly drawing a different layout.
 *
 * Content and titles are flattened (`flattenText`): a `\n` inside a JSON string
 * would otherwise reach a one-dimensional row array and break both the row count
 * and the terminal width accounting.
 *
 * Errors carry the JSON path of the offending node, e.g.
 * `layout.children[1].type: expected one of chafa, layout, window (got "chart")`.
 * The parser never throws.
 */

import {
	cloneLayout,
	DEFAULT_LAYOUT,
	flattenText,
	type ContentSpec,
	type LayoutMode,
	type LayoutNode,
} from "../layout/tree.ts";
import { LIMITS } from "./schema.ts";

export interface ParsedLayout {
	tree?: LayoutNode;
	error?: string;
	/** Non-structural problems: sanitized control characters, mistyped optional fields. */
	warnings: string[];
}

const NODE_TYPES = ["chafa", "layout", "window"] as const;
const CONTENT_TYPES = ["inline", "outline"] as const;

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/** Short, JSON-ish rendering of a bad value for error messages. */
function show(value: unknown): string {
	if (value === undefined) return "undefined";
	if (typeof value === "string") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.length} items]`;
	if (value === null) return "null";
	return String(value);
}

/** `"hello world"` -> `"Hello world"`: the default `[Title]` for a bare content name. */
function humanize(name: string): string {
	const trimmed = name.trim();
	if (!trimmed) return "";
	return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function parseContentSpec(
	raw: unknown,
	path: string,
	warnings: string[],
): { spec?: ContentSpec; error?: string } {
	if (!isObject(raw)) return { error: `${path}: expected an object (got ${show(raw)})` };

	const type = raw.type;
	if (type !== "inline" && type !== "outline") {
		return {
			error: `${path}.type: expected one of ${CONTENT_TYPES.join(", ")} (got ${show(type)})`,
		};
	}
	if (typeof raw.content !== "string") {
		return { error: `${path}.content: expected a string (got ${show(raw.content)})` };
	}

	const content = flattenField(raw.content, `${path}.content`, warnings);
	let title: string;
	if (typeof raw.title === "string" && raw.title.trim() !== "") {
		title = flattenField(raw.title, `${path}.title`, warnings).trim();
	} else {
		if (raw.title !== undefined) warnings.push(`${path}.title: expected a non-empty string (got ${show(raw.title)})`);
		title = humanize(content);
	}

	if (raw.stacked !== undefined && typeof raw.stacked !== "boolean") {
		warnings.push(`${path}.stacked: expected true or false (got ${show(raw.stacked)}); using false`);
	}
	const spec: ContentSpec = { type, title, content };
	if (raw.stacked === true) spec.stacked = true;
	return { spec };
}

/** Flatten control characters out of a config string, warning once when they were there. */
function flattenField(value: string, path: string, warnings: string[]): string {
	const flat = flattenText(value);
	if (flat !== value) warnings.push(`${path}: line breaks/tabs/control characters replaced with spaces`);
	return flat;
}

/**
 * Parse one node. `path` is the JSON path (`layout`, `layout.children[0]`, …).
 *
 * A missing `mode` defaults to `"vertical"` (the common way to stack windows);
 * a missing `weight` to 1; a missing title is left undefined so the renderer can
 * pick its own heading.
 */
function parseNode(raw: unknown, path: string, warnings: string[]): { node?: LayoutNode; error?: string } {
	if (!isObject(raw)) return { error: `${path}: expected an object (got ${show(raw)})` };

	const type = raw.type;
	if (typeof type !== "string" || !(NODE_TYPES as readonly string[]).includes(type)) {
		return {
			error: `${path}.type: expected one of ${NODE_TYPES.join(", ")} (got ${show(type)})`,
		};
	}

	const weight = raw.weight === undefined ? 1 : raw.weight;
	if (typeof weight !== "number" || !Number.isFinite(weight) || weight <= 0) {
		return { error: `${path}.weight: expected a positive number (got ${show(raw.weight)})` };
	}
	// A huge weight is not structural (the layout still means something), it is
	// just unhelpful, so it is capped like every other numeric limit.
	const cappedWeight = Math.min(weight, LIMITS.weight.max);
	if (cappedWeight !== weight) warnings.push(`${path}.weight: capped at ${LIMITS.weight.max}`);

	if (type === "chafa") {
		const node: LayoutNode = { type: "chafa", weight: cappedWeight };
		if (typeof raw.img === "string" && raw.img.trim() !== "") node.img = raw.img.trim();
		else if (raw.img !== undefined) {
			warnings.push(`${path}.img: expected a non-empty path (got ${show(raw.img)}); using image.path`);
		}
		if (typeof raw.args === "string" && raw.args.trim() !== "") node.args = raw.args.trim();
		else if (raw.args !== undefined) {
			warnings.push(`${path}.args: expected a string (got ${show(raw.args)}); using image.chafa only`);
		}
		return { node };
	}

	if (type === "layout") {
		if (!Array.isArray(raw.children) || raw.children.length === 0) {
			return { error: `${path}.children: expected a non-empty array (got ${show(raw.children)})` };
		}
		let mode: LayoutMode;
		if (raw.mode === undefined) mode = "vertical";
		else if (raw.mode === "horizontal" || raw.mode === "vertical") mode = raw.mode;
		else return { error: `${path}.mode: expected "horizontal" or "vertical" (got ${show(raw.mode)})` };

		const children: LayoutNode[] = [];
		for (const [index, childRaw] of raw.children.entries()) {
			const parsed = parseNode(childRaw, `${path}.children[${index}]`, warnings);
			if (parsed.error) return { error: parsed.error };
			children.push(parsed.node as LayoutNode);
		}
		return { node: { type: "layout", weight: cappedWeight, mode, children } };
	}

	if (!Array.isArray(raw.content)) {
		return { error: `${path}.content: expected an array (got ${show(raw.content)})` };
	}
	const content: ContentSpec[] = [];
	for (const [index, specRaw] of raw.content.entries()) {
		const parsed = parseContentSpec(specRaw, `${path}.content[${index}]`, warnings);
		if (parsed.error) return { error: parsed.error };
		content.push(parsed.spec as ContentSpec);
	}
	const node: LayoutNode = { type: "window", weight: cappedWeight, content };
	if (typeof raw.title === "string" && raw.title.trim() !== "") {
		node.title = flattenField(raw.title, `${path}.title`, warnings).trim();
	} else if (raw.title !== undefined) {
		warnings.push(`${path}.title: expected a non-empty string (got ${show(raw.title)}); using WINDOW`);
	}
	return { node };
}

/**
 * Parse the `layout` subtree.
 *
 * `raw === undefined` means "use the built-in layout"; anything else must be a
 * valid tree. Structural problems come back as `error` (never as a fallback
 * tree), so the caller can render the error card and skip measuring.
 */
export function parseLayoutTree(raw: unknown, path = "layout"): ParsedLayout {
	const warnings: string[] = [];
	if (raw === undefined) return { tree: cloneLayout(DEFAULT_LAYOUT), warnings };
	const parsed = parseNode(raw, path, warnings);
	return parsed.error !== undefined ? { error: parsed.error, warnings } : { tree: parsed.node, warnings };
}

/** True when `layout` looks like a v2 tree (has `type` or `children`). */
export function hasLayoutTree(raw: unknown): boolean {
	if (!isObject(raw)) return false;
	return typeof raw.type === "string" || Array.isArray(raw.children);
}
