/**
 * Recursive size allocation: how many cells each node gets, and when that is
 * impossible.
 *
 * The solver is deterministic — the same tree, weights and box always produce the
 * same numbers. It runs in one pass per axis:
 *
 *   1. split the available cells by weight with the largest-remainder method, so
 *      the shares sum to exactly the available amount;
 *   2. raise anything below its minimum by taking cells from whoever sits
 *      furthest above its own minimum;
 *   3. stop rigid nodes (chafa canvases) at their natural size and spend the
 *      spare on preference gaps, biggest gap first;
 *   3b. if nothing is spare but a flexible node is still below its preference, a
 *      sibling that can afford it gives up one cell at a time (a rigid canvas
 *      is cropped down to its minimum, a flexible sibling only gives away what
 *      it holds above its own preference) — this is what keeps an info card
 *      from collapsing to a single `…` on a short terminal;
 *   4. if cells are still spare, flexible nodes (windows) absorb them in
 *      proportion to their weights.
 *
 * A node that ends up below its minimum is a user error the renderer must show,
 * so `distribute` throws `LayoutError` with the node path instead of quietly
 * shrinking the box.
 */

import {
	assertTree,
	gapOn,
	LayoutError,
	NODE_MIN,
	nodePathOf,
	planForPath,
	proportionalShares,
	weightOf,
	type Box,
	type ChafaPlan,
	type LayoutNode,
	type Measure,
	type SplashGap,
	type SplashSettings,
	type WindowNode,
} from "./tree.ts";

/** Size a node asks for on one axis. */
interface AxisSpec {
	weight: number;
	min: number;
	pref: number;
	flexible: boolean;
}

/** Content-driven size of a window, measured at a given inner width. */
type ContentNeed = (
	node: WindowNode,
	width: number,
) => { minHeight: number; prefHeight: number; minWidth: number; prefWidth: number };

// ---------------------------------------------------------------------------
// allocation
// ---------------------------------------------------------------------------

/**
 * Distribute `available` cells among weighted children.
 *
 * `min` is a hard floor, `pref` the size a node wants. Rigid nodes stop at
 * `pref`; flexible nodes take whatever is left over after every preference is
 * met. When the minimums cannot all fit, the result stays proportional and the
 * caller (`distribute`) reports the offending node.
 */
export function allocate(
	sizes: readonly { weight: number; min: number; pref: number; flexible: boolean }[],
	available: number,
	options: { borrow?: boolean } = {},
): number[] {
	const count = sizes.length;
	if (count === 0) return [];
	const total = Math.max(0, Math.floor(Number.isFinite(available) ? available : 0));
	const weights = sizes.map((size) => (Number.isFinite(size.weight) && size.weight > 0 ? size.weight : 1));
	const mins = sizes.map((size) => Math.max(0, Math.floor(Number.isFinite(size.min) ? size.min : 0)));
	const prefs = sizes.map((size, index) =>
		Math.max(mins[index] ?? 0, Number.isFinite(size.pref) ? Math.floor(size.pref) : (mins[index] ?? 0)),
	);
	const out = proportionalShares(total, weights);

	// 1. Minimum floor, funded by the children furthest above their own minimum.
	for (let index = 0; index < count; index++) {
		let shortfall = (mins[index] ?? 0) - (out[index] ?? 0);
		while (shortfall > 0) {
			const donor = pickDonor(out, mins);
			if (donor < 0) break; // not enough cells to satisfy every minimum
			out[donor] = (out[donor] ?? 0) - 1;
			out[index] = (out[index] ?? 0) + 1;
			shortfall -= 1;
		}
	}

	// 2. Rigid nodes are fixed at their natural size.
	let spare = 0;
	for (let index = 0; index < count; index++) {
		if (sizes[index]?.flexible) continue;
		const over = (out[index] ?? 0) - (prefs[index] ?? 0);
		if (over > 0) {
			out[index] = (out[index] ?? 0) - over;
			spare += over;
		}
	}

	// 3. Spend the spare on preference gaps; biggest gap wins, ties go left.
	while (spare > 0) {
		let best = -1;
		let bestGap = 0;
		for (let index = 0; index < count; index++) {
			const gap = (prefs[index] ?? 0) - (out[index] ?? 0);
			if (gap > bestGap) {
				bestGap = gap;
				best = index;
			}
		}
		if (best < 0) break;
		out[best] = (out[best] ?? 0) + 1;
		spare -= 1;
	}

	// 3b. Tight box: minimums and preferences cannot both be funded out of the
	// spare cells. A flexible node still short of its preference borrows one cell
	// at a time from a sibling that can afford it. This is what keeps a 4-row
	// info card intact on a 16-row terminal: the artwork is cropped, not the text.
	// Height only: a borrowed column would desync the canvas box from the plan and
	// break the documented side-by-side split, so widths stay proportional.
	let borrowed = 0;
	while (options.borrow === true && spare === 0 && borrowed < total) {
		let needy = -1;
		let deficit = 0;
		for (let index = 0; index < count; index++) {
			if (!sizes[index]?.flexible) continue;
			const gap = (prefs[index] ?? 0) - (out[index] ?? 0);
			if (gap > deficit) {
				deficit = gap;
				needy = index;
			}
		}
		if (needy < 0) break;
		const donor = pickBorrowDonor(out, mins, prefs, sizes, needy);
		if (donor < 0) break;
		out[donor] = (out[donor] ?? 0) - 1;
		out[needy] = (out[needy] ?? 0) + 1;
		borrowed += 1;
	}

	// 3c. The weight split is only a starting point: a rigid canvas left below its
	// planned size while a flexible sibling sits above its own preference gets
	// those cells back (`12/4` instead of `8/8` for a 43x12 canvas plus a two-row
	// card in a 17-row box). Height only, for the same reason as 3b.
	if (options.borrow === true) {
		for (;;) {
			let needy = -1;
			let deficit = 0;
			for (let index = 0; index < count; index++) {
				if (sizes[index]?.flexible) continue;
				const gap = (prefs[index] ?? 0) - (out[index] ?? 0);
				if (gap > deficit) {
					deficit = gap;
					needy = index;
				}
			}
			if (needy < 0) break;
			let donor = -1;
			let excess = 0;
			for (let index = 0; index < count; index++) {
				if (!sizes[index]?.flexible) continue;
				const over = (out[index] ?? 0) - (prefs[index] ?? 0);
				if (over > excess) {
					excess = over;
					donor = index;
				}
			}
			if (donor < 0) break;
			out[donor] = (out[donor] ?? 0) - 1;
			out[needy] = (out[needy] ?? 0) + 1;
		}
	}

	// 4. Anything still unclaimed goes to the flexible children, by weight.
	if (spare > 0) {
		const flexible: number[] = [];
		for (let index = 0; index < count; index++) {
			if (sizes[index]?.flexible) flexible.push(index);
		}
		if (flexible.length > 0) {
			const shares = proportionalShares(
				spare,
				flexible.map((index) => weights[index] ?? 1),
			);
			flexible.forEach((index, slot) => {
				out[index] = (out[index] ?? 0) + (shares[slot] ?? 0);
			});
		}
	}
	return out;
}

/** Finite integer floor of `value`, or `fallback` when it is missing/garbage. */
function intOr(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

/** Index of the child furthest above its minimum (tie → lowest index), or -1. */
function pickDonor(out: readonly number[], mins: readonly number[]): number {
	let best = -1;
	let bestSlack = 0;
	for (let index = 0; index < out.length; index++) {
		const slack = (out[index] ?? 0) - (mins[index] ?? 0);
		if (slack > bestSlack) {
			bestSlack = slack;
			best = index;
		}
	}
	return best;
}

/**
 * Index of the child that can give one cell to `exclude` without dropping below
 * what it actually needs, or -1.
 *
 * A rigid canvas donates down to its minimum (it is cropped); a flexible
 * sibling only donates the cells it holds above its own preference, so two
 * windows cannot rob each other in a circle.
 */
function pickBorrowDonor(
	out: readonly number[],
	mins: readonly number[],
	prefs: readonly number[],
	sizes: readonly { flexible: boolean }[],
	exclude: number,
): number {
	let best = -1;
	let bestUsable = 0;
	for (let index = 0; index < out.length; index++) {
		if (index === exclude) continue;
		const slack = (out[index] ?? 0) - (mins[index] ?? 0);
		if (slack <= 0) continue;
		const usable = sizes[index]?.flexible
			? Math.min(slack, (out[index] ?? 0) - (prefs[index] ?? 0))
			: slack;
		if (usable > bestUsable) {
			bestUsable = usable;
			best = index;
		}
	}
	return best;
}

// ---------------------------------------------------------------------------
// measuring
// ---------------------------------------------------------------------------

/**
 * Size a node wants on one axis. `cross` is the extent of the other axis (a
 * window's content height depends on how wide it will be, so `contentNeed` is
 * only consulted while allocating heights).
 */
function axisSpec(
	node: LayoutNode,
	indexes: readonly number[],
	axis: "width" | "height",
	cross: number,
	plans: readonly ChafaPlan[],
	contentNeed: ContentNeed | undefined,
	gap: SplashGap,
): AxisSpec {
	const weight = weightOf(node);
	if (node.type === "chafa") {
		const plan = planForPath(plans, nodePathOf(indexes));
		const floor = NODE_MIN.chafa[axis];
		const natural = axis === "width" ? (plan?.width ?? floor) : (plan?.height ?? floor);
		return { weight, min: floor, pref: Math.max(floor, Math.floor(natural)), flexible: false };
	}
	if (node.type === "window") {
		const floor = NODE_MIN.window[axis];
		// Content height depends on the inner width, which is only known while
		// allocating heights (width is the cross axis there). Width preferences
		// are measured against the minimum width — a window's natural width does
		// not depend on how much room it is given.
		const measuredAt = axis === "height" ? Math.max(1, Math.floor(cross)) : NODE_MIN.window.width;
		const need = contentNeed ? contentNeed(node, measuredAt) : undefined;
		const min = Math.max(floor, intOr(need?.[axis === "width" ? "minWidth" : "minHeight"], floor));
		const pref = Math.max(min, intOr(need?.[axis === "width" ? "prefWidth" : "prefHeight"], min));
		return { weight, min, pref, flexible: true };
	}
	const children = node.children.map((child, index) =>
		axisSpec(child, [...indexes, index], axis, cross, plans, contentNeed, gap),
	);
	if (children.length === 0) return { weight, min: 0, pref: 0, flexible: false };
	// A horizontal group splits widths (sums them, heights take the max);
	// a vertical group does the transpose.
	const split = (axis === "width") === (node.mode === "horizontal");
	// The split axis owns the margin: horizontal groups separate with columns,
	// vertical groups with rows.
	const along = gapOn(node.mode === "horizontal" ? "width" : "height", gap);
	const margins = split ? along * Math.max(0, children.length - 1) : 0;
	const reduced = (pick: (spec: AxisSpec) => number) =>
		children.reduce((sum, spec) => sum + pick(spec), margins);
	const min = split ? reduced((spec) => spec.min) : Math.max(...children.map((spec) => spec.min));
	const pref = split ? reduced((spec) => spec.pref) : Math.max(...children.map((spec) => spec.pref));
	return {
		weight,
		min,
		pref: Math.max(min, pref),
		flexible: children.some((spec) => spec.flexible),
	};
}

function measureNode(
	node: LayoutNode,
	indexes: readonly number[],
	widthHint: number,
	plans: readonly ChafaPlan[],
	contentNeed: ContentNeed | undefined,
	gap: SplashGap,
): Measure {
	const width = axisSpec(node, indexes, "width", widthHint, plans, contentNeed, gap);
	const height = axisSpec(node, indexes, "height", widthHint, plans, contentNeed, gap);
	return {
		minWidth: width.min,
		minHeight: height.min,
		prefWidth: Math.max(width.min, width.pref),
		prefHeight: Math.max(height.min, height.pref),
		flexible: width.flexible || height.flexible,
	};
}

/** Natural size of the whole tree when measured against the configured width. */
export function measureTree(
	root: LayoutNode,
	settings: SplashSettings,
	plans: readonly ChafaPlan[],
	contentNeed?: (node: WindowNode, width: number) => { minHeight: number; prefHeight: number; minWidth: number; prefWidth: number },
): Measure {
	const gap = settings.gap;
	const widthHint = Math.max(1, Math.floor(settings.width));
	return measureNode(root, [], widthHint, plans, contentNeed, gap);
}

// ---------------------------------------------------------------------------
// distributing
// ---------------------------------------------------------------------------

/**
 * Box for every node, keyed by node path (`root`, `root.0`, `root.0.1`, …).
 *
 * Throws `LayoutError` when a child is smaller than its minimum on either axis:
 * a 20-column box cannot host two 12-column windows, and silently shrinking one
 * is exactly the "quiet degradation" the layout rewrite is meant to remove.
 */
export function distribute(
	root: LayoutNode,
	box: Box,
	settings: SplashSettings,
	plans: readonly ChafaPlan[],
	contentNeed?: (node: WindowNode, width: number) => { minHeight: number; prefHeight: number; minWidth: number; prefWidth: number },
	/** Path prefix of `root` inside the whole tree; `[]` means `root` itself. */
	baseIndexes: readonly number[] = [],
): Map<string, Box> {
	const gap = settings.gap;
	const boxes = new Map<string, Box>();
	// Structure first, sizes second: an unknown node kind has no `children`, so
	// allocating before this check would crash instead of reporting the node.
	assertTree(root, baseIndexes);

	const visit = (node: LayoutNode, indexes: readonly number[], target: Box): void => {
		const path = nodePathOf(indexes);
		const width = Math.max(0, Math.floor(target.width));
		const height = Math.max(0, Math.floor(target.height));
		boxes.set(path, { width, height });
		if (node.type !== "layout") return;

		const children = node.children.map((child, index) => ({
			child,
			indexes: [...indexes, index] as number[],
			path: nodePathOf([...indexes, index]),
		}));
		const horizontal = node.mode === "horizontal";
		const along = gapOn(horizontal ? "width" : "height", gap);
		const available = Math.max(0, (horizontal ? width : height) - along * Math.max(0, children.length - 1));
		const specs = children.map(({ child, indexes: childIndexes }) =>
			axisSpec(child, childIndexes, horizontal ? "width" : "height", horizontal ? height : width, plans, contentNeed, gap),
		);
		const sizes = allocate(specs, available, { borrow: !horizontal });

		children.forEach(({ child, indexes: childIndexes, path }, index) => {
			const spec = specs[index];
			const size = sizes[index] ?? 0;
			const unit = horizontal ? "columns" : "rows";
			if (spec && size < spec.min) {
				throw new LayoutError(path, `needs at least ${spec.min} ${unit}, only ${size} available`);
			}
			// The cross axis is handed down unchanged, so its minimum has to hold too.
			const cross = axisSpec(child, childIndexes, horizontal ? "height" : "width", horizontal ? width : height, plans, contentNeed, gap);
			const extent = horizontal ? height : width;
			const crossUnit = horizontal ? "rows" : "columns";
			if (cross.min > extent) {
				throw new LayoutError(path, `needs at least ${cross.min} ${crossUnit}, only ${extent} available`);
			}
			visit(child, childIndexes, horizontal ? { width: size, height } : { width, height: size });
		});
	};

	visit(root, baseIndexes, box);
	return boxes;
}
