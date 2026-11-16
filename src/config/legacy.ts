/**
 * v1 → v2 config translation.
 *
 * Before the recursive layout tree, the splash was described by a flat `layout`
 * group (`width`, `gap`, `twoColumnMinWidth`, …) plus a `panels` group that
 * listed the info fields and resource sections. v2 replaces both with a
 * `layout` tree, so a v1 file is translated into an equivalent tree instead of
 * being dropped: artwork above the info card on the left, resources on the
 * right, same chafa canvas, same rows.
 *
 * Detection is structural and matches `parseLayoutTree`: a `layout` object with
 * a `type` or `children` key is a v2 tree; anything else is v1.
 */

import {
	cloneLayout,
	DEFAULT_LAYOUT,
	type ContentSpec,
	type LayoutNode,
	type WindowNode,
} from "../layout/tree.ts";
import { SECTION_STYLE } from "../content.ts";
import { DEFAULT_FILE, PANEL_FIELDS, RESOURCE_SECTIONS, type PanelField, type ResourceSectionId } from "./schema.ts";

export interface LegacyLayout {
	/** Equivalent v2 tree (a deep copy of `DEFAULT_LAYOUT` with panels applied). */
	tree: LayoutNode;
	/** v1 `layout.width`, if it was a number. */
	width?: number;
	/** v1 `layout.gap`, if it was a number. */
	gap?: number;
	/** v1 `layout.compactMinWidth`, if it was a number. */
	compactWidth?: number;
	warnings: string[];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function finite(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function capitalize(name: string): string {
	return name.charAt(0).toUpperCase() + name.slice(1);
}

/** Depth-first lookup of the first window with a given title. */
function findWindow(node: LayoutNode, title: string): WindowNode | undefined {
	if (node.type === "window") return node.title === title ? node : undefined;
	if (node.type === "layout") {
		for (const child of node.children) {
			const found = findWindow(child, title);
			if (found) return found;
		}
	}
	return undefined;
}

/**
 * Remove the first window called `title`, pruning groups that become empty.
 *
 * A disabled v1 panel rendered *nothing*, so translation has to drop the node
 * instead of keeping an empty box (the artwork is never a window, so the tree
 * cannot collapse to nothing).
 */
function dropWindow(node: LayoutNode, title: string): LayoutNode | undefined {
	if (node.type === "window") return node.title === title ? undefined : node;
	if (node.type !== "layout") return node;
	const children: LayoutNode[] = [];
	for (const child of node.children) {
		const kept = dropWindow(child, title);
		if (kept !== undefined) children.push(kept);
	}
	if (children.length === 0) return undefined;
	return { ...node, children };
}

function show(value: unknown): string {
	if (typeof value === "string") return JSON.stringify(value);
	if (value === null) return "null";
	if (Array.isArray(value)) return `[${value.length} items]`;
	return String(value);
}

function infoSpec(field: PanelField): ContentSpec {
	return { type: "inline", title: capitalize(field), content: field };
}

function sectionSpec(id: ResourceSectionId): ContentSpec {
	// Title and stacking come from the content layer so v1 translation and the
	// legacy panels cannot drift apart.
	const style = SECTION_STYLE[id];
	const spec: ContentSpec = { type: "outline", title: style?.title ?? capitalize(id), content: id };
	if (style?.stacked) spec.stacked = true;
	return spec;
}

/** Strings from `raw` that are members of `allowed`, de-duplicated, order kept. */
function pick<T extends string>(
	raw: unknown,
	allowed: readonly T[],
	path: string,
	warnings: string[],
): T[] | undefined {
	if (raw === undefined) return undefined;
	if (!Array.isArray(raw)) {
		warnings.push(`${path}: expected an array of ${allowed.join(", ")}, got ${show(raw)}; ignored when translating`);
		return undefined;
	}
	const kept: T[] = [];
	for (const entry of raw) {
		if (typeof entry !== "string" || !allowed.includes(entry as T)) {
			warnings.push(`${path}: ${show(entry)} is not one of ${allowed.join(", ")}; dropped when translating`);
			continue;
		}
		if (!kept.includes(entry as T)) kept.push(entry as T);
	}
	return kept;
}

/**
 * Translate whatever `JSON.parse` produced into v2 values.
 *
 * Only called when the `layout` key is not a v2 tree. The returned tree is
 * always usable (`DEFAULT_LAYOUT` is the base); the warnings explain every v1
 * key that had no direct equivalent.
 */
export function translateLegacyConfig(raw: unknown): LegacyLayout {
	const file = isObject(raw) ? raw : {};
	const layout = isObject(file.layout) ? file.layout : {};
	const panels = isObject(file.panels) ? file.panels : {};
	const info = isObject(panels.info) ? panels.info : {};
	const resources = isObject(panels.resources) ? panels.resources : {};

	const width = finite(layout.width);
	const gap = finite(layout.gap);
	const compactWidth = finite(layout.compactMinWidth);

	const tree = cloneLayout(DEFAULT_LAYOUT);
	const warnings: string[] = [];

	if (file.layout !== undefined && !isObject(file.layout) && file.layout !== null) {
		warnings.push(`layout: expected an object, got ${show(file.layout)}; using the default tree`);
	}
	if (file.panels !== undefined && !isObject(file.panels)) {
		warnings.push(`panels: expected an object, got ${show(file.panels)}; ignored when translating`);
	}

	// Known v1 layout keys with no v2 counterpart: say so instead of losing them.
	for (const key of ["maxWidth", "twoColumnMinWidth", "lowerRows"]) {
		if (layout[key] !== undefined) {
			warnings.push(`layout.${key}: no layout-tree equivalent; ignored when translating`);
		}
	}

	let nextTree: LayoutNode | undefined = tree;
	if (nextTree) {
		const infoWindow = findWindow(nextTree, "CODING AGENT");
		if (infoWindow) {
			if (info.enabled === false) {
				warnings.push("panels.info.enabled: false; the CODING AGENT window is dropped when translating");
				nextTree = dropWindow(nextTree, "CODING AGENT");
			} else {
				const fields = pick(info.fields, PANEL_FIELDS, "panels.info.fields", warnings);
				if (fields !== undefined) {
					const usable: ContentSpec[] = [];
					for (const field of fields) {
						if (field === "gif" || field === "frames") {
							warnings.push(`panels.info.fields: "${field}" has no content provider; dropped when translating`);
							continue;
						}
						usable.push(infoSpec(field));
					}
					infoWindow.content = usable;
				}
			}
		}
	}

	if (nextTree) {
		const resourcesWindow = findWindow(nextTree, "RESOURCES");
		if (resourcesWindow) {
			if (resources.enabled === false) {
				warnings.push("panels.resources.enabled: false; the RESOURCES window is dropped when translating");
				nextTree = dropWindow(nextTree, "RESOURCES");
			} else {
				const sections = pick(resources.sections, RESOURCE_SECTIONS, "panels.resources.sections", warnings);
				if (sections !== undefined) resourcesWindow.content = sections.map(sectionSpec);
			}
			if (resources.maxLinesPerSection !== undefined) {
				warnings.push("panels.resources.maxLinesPerSection: no layout-tree equivalent; ignored when translating");
			}
		}
	}
	for (const key of ["width", "height"]) {
		if (resources[key] !== undefined) {
			warnings.push(`panels.resources.${key}: no layout-tree equivalent; ignored when translating`);
		}
	}

	// The artwork is always a `chafa` node, so the tree survives both panels
	// being disabled; the fallback only guards against a future shape change.
	const finalTree = nextTree ?? tree;

	const hasMarkers =
		finite(layout.width) !== undefined ||
		finite(layout.gap) !== undefined ||
		finite(layout.compactMinWidth) !== undefined ||
		Object.keys(layout).length > 0 ||
		Object.keys(panels).length > 0 ||
		file.version === 1;

	if (hasMarkers) {
		const summary = [
			`width=${width ?? DEFAULT_FILE.width}`,
			`gap=${gap ?? DEFAULT_FILE.gap}`,
			`compactWidth=${compactWidth ?? DEFAULT_FILE.compactWidth}`,
			`info=${(findWindow(finalTree, "CODING AGENT")?.content.map((spec) => spec.content) ?? []).join("+") || "(none)"}`,
			`resources=${(findWindow(finalTree, "RESOURCES")?.content.map((spec) => spec.content) ?? []).join("+") || "(none)"}`,
		];
		const label = file.version === 1 ? "version 1 config" : "flat layout";
		warnings.unshift(`${label}: translated to the layout tree (${summary.join(", ")})`);
	}

	const out: LegacyLayout = { tree: finalTree, warnings };
	if (width !== undefined) out.width = width;
	if (gap !== undefined) out.gap = gap;
	if (compactWidth !== undefined) out.compactWidth = compactWidth;
	return out;
}
