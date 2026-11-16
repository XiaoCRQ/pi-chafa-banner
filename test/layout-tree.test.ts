import { describe, expect, test } from "bun:test";
import { autoHeightFor } from "../src/config.ts";
import {
	allocate,
	DEFAULT_LAYOUT,
	distribute,
	LayoutError,
	measureTree,
	NODE_MIN,
	nodePathOf,
	planChafaNodes,
	planForPath,
	plansForWidth,
	proportionalShares,
	type ChafaPlan,
	type LayoutGroup,
	type SplashSettings,
} from "../src/layout.ts";
import {
	PROVIDERS,
	registerProvider,
	resolveContent,
	type ContentContext,
} from "../src/content.ts";

const SETTINGS: SplashSettings = {
	width: 88,
	height: 50,
	gap: { width: 2, height: 1 },
	variableWidth: false,
	variableHeight: true,
	compactWidth: 32,
};

function settingsWith(overrides: Partial<SplashSettings>): SplashSettings {
	return { ...SETTINGS, ...overrides };
}

function box(map: Map<string, { width: number; height: number }>, path: string) {
	const found = map.get(path);
	if (!found) throw new Error(`missing box for ${path}`);
	return found;
}

describe("allocate", () => {
	test("equal weights split the available cells evenly", () => {
		expect(allocate([{ weight: 1, min: 1, pref: 100, flexible: false }, { weight: 1, min: 1, pref: 100, flexible: false }], 40)).toEqual([20, 20]);
		expect(allocate([{ weight: 5, min: 1, pref: 100, flexible: false }, { weight: 5, min: 1, pref: 100, flexible: false }], 40)).toEqual([20, 20]);
	});

	test("weights are ratios within one layout node", () => {
		expect(allocate([{ weight: 1, min: 1, pref: 100, flexible: false }, { weight: 9, min: 1, pref: 100, flexible: false }], 40)).toEqual([4, 36]);
		const [small, large] = allocate(
			[{ weight: 1, min: 1, pref: 100, flexible: false }, { weight: 9, min: 1, pref: 100, flexible: false }],
			10,
		);
		expect((small ?? 0) + (large ?? 0)).toBe(10);
		expect(small).toBe(1);
		expect(large).toBe(9);
	});

	test("largest remainder keeps the total exact", () => {
		expect(proportionalShares(10, [1, 1, 1])).toEqual([4, 3, 3]);
		for (let available = 0; available <= 40; available++) {
			const shares = proportionalShares(available, [1, 2, 4]);
			expect(shares.reduce((sum, share) => sum + share, 0)).toBe(available);
			// Deterministic: the same call returns the same numbers.
			expect(proportionalShares(available, [1, 2, 4])).toEqual(shares);
		}
		const sizes = allocate(
			[
				{ weight: 1, min: 0, pref: 100, flexible: false },
				{ weight: 2, min: 0, pref: 100, flexible: false },
				{ weight: 4, min: 0, pref: 100, flexible: false },
			],
			7,
		);
		expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(7);
	});

	test("a rigid node stops at its preference and the surplus is redistributed", () => {
		const sizes = allocate(
			[
				{ weight: 9, min: 1, pref: 5, flexible: false },
				{ weight: 1, min: 1, pref: 40, flexible: false },
			],
			40,
		);
		expect(sizes).toEqual([5, 35]);
	});

	test("flexible nodes absorb what the rigid ones cannot use", () => {
		const sizes = allocate(
			[
				{ weight: 1, min: 3, pref: 6, flexible: true },
				{ weight: 5, min: 4, pref: 10, flexible: false },
			],
			40,
		);
		expect(sizes).toEqual([30, 10]);
		expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(40);
	});

	test("minimums are funded before preferences", () => {
		const sizes = allocate(
			[{ weight: 20, min: 4, pref: 100, flexible: false }, { weight: 1, min: 12, pref: 12, flexible: true }],
			20,
		);
		expect(sizes[1]).toBeGreaterThanOrEqual(12);
		expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(20);
	});

	test("cells nobody can use are left unassigned", () => {
		const sizes = allocate(
			[
				{ weight: 1, min: 1, pref: 10, flexible: false },
				{ weight: 1, min: 1, pref: 10, flexible: false },
			],
			40,
		);
		expect(sizes).toEqual([10, 10]);
	});

	test("the same input always yields the same split", () => {
		const sizes = [
			{ weight: 1, min: 1, pref: 100, flexible: false },
			{ weight: 1, min: 1, pref: 100, flexible: false },
			{ weight: 1, min: 1, pref: 100, flexible: false },
		];
		expect(allocate(sizes, 10)).toEqual([4, 3, 3]);
		expect(allocate(sizes, 10)).toEqual(allocate(sizes, 10));
	});
});

describe("node paths", () => {
	test("root is the empty path and children are dotted indexes", () => {
		expect(nodePathOf([])).toBe("root");
		expect(nodePathOf([0])).toBe("root.0");
		expect(nodePathOf([0, 1])).toBe("root.0.1");
	});
});

describe("DEFAULT_LAYOUT", () => {
	test("reproduces the tokyonight splash shape", () => {
		expect(DEFAULT_LAYOUT.type).toBe("layout");
		expect(DEFAULT_LAYOUT.mode).toBe("horizontal");

		const [left, right] = DEFAULT_LAYOUT.children;
		expect(left?.type).toBe("layout");
		expect(left?.weight).toBe(5);
		expect(right?.type).toBe("window");
		expect(right?.weight).toBe(5);

		const leftGroup = left as LayoutGroup;
		expect(leftGroup.mode).toBe("vertical");
		const [art, card] = leftGroup.children;
		expect(art?.type).toBe("chafa");
		expect(art?.weight).toBe(1);
		expect(card?.type).toBe("window");
		expect(card?.type === "window" ? card.title : undefined).toBe("CODING AGENT");
		const cardContent = card?.type === "window" ? card.content : [];
		expect(cardContent.map((spec) => [spec.type, spec.title, spec.content])).toEqual([
			["inline", "Version", "version"],
			["inline", "Model", "model"],
		]);
	});

	test("the RESOURCES window lists context, skills and stacked extensions", () => {
		const right = DEFAULT_LAYOUT.children[1];
		if (right?.type !== "window") throw new Error("expected a window");
		expect(right.title).toBe("RESOURCES");
		expect(right.content.map((spec) => [spec.type, spec.content, spec.stacked ?? false])).toEqual([
			["outline", "context", false],
			["outline", "skills", false],
			["outline", "extensions", true],
		]);
	});
});

describe("planChafaNodes", () => {
	test("plans one canvas at the column width, height from the cell aspect", () => {
		const plans = planChafaNodes(DEFAULT_LAYOUT, SETTINGS, "~/art.gif", []);
		expect(plans.length).toBe(1);
		const plan = plans[0] as ChafaPlan;
		expect(plan.key).toBe("root.0.0");
		expect(plan.path).toBe("root.0.0");
		expect(plan.image).toBe("~/art.gif");
		expect(plan.width).toBe(43); // (88 - 2) / 2
		expect(plan.height).toBe(autoHeightFor(43));
		expect(planForPath(plans, "root.0.0")).toBe(plan);
		expect(planForPath(plans, "root.9")).toBeUndefined();
	});

	test("keys are stable across identical calls", () => {
		const first = planChafaNodes(DEFAULT_LAYOUT, SETTINGS, "~/art.gif", ["--symbols", "solid"]);
		const second = planChafaNodes(DEFAULT_LAYOUT, SETTINGS, "~/art.gif", ["--symbols", "solid"]);
		expect(second).toEqual(first);
	});

	test("horizontal weights split the canvas, per-node args are merged and sanitized", () => {
		const tree: LayoutGroup = {
			type: "layout",
			weight: 1,
			mode: "horizontal",
			children: [
				{ type: "chafa", weight: 1, img: "small.gif", args: "--probe on --symbols block --clear" },
				{ type: "chafa", weight: 9 },
			],
		};
		const plans = planChafaNodes(tree, settingsWith({ width: 88, gap: { width: 2, height: 1 } }), "fallback.gif", ["--animate", "off", "--symbols", "solid"]);
		expect(plans.map((plan) => plan.width)).toEqual([9, 77]);
		expect(plans[0]?.image).toBe("small.gif");
		expect(plans[1]?.image).toBe("fallback.gif");
		// The node's arguments come last (so they win), and the pipeline's own
		// flags (--probe/--animate/--clear) are dropped from both sources.
		expect(plans[0]?.args).toEqual(["--symbols", "solid", "--symbols", "block"]);
		expect(plans[0]?.height).toBe(autoHeightFor(9));
	});

	test("a canvas is never planned below the node minimum", () => {
		const tree: LayoutGroup = {
			type: "layout",
			weight: 1,
			mode: "horizontal",
			children: [
				{ type: "chafa", weight: 1 },
				{ type: "chafa", weight: 50 },
			],
		};
		const plans = planChafaNodes(tree, settingsWith({ width: 20, gap: { width: 0, height: 0 } }), undefined, []);
		expect(plans[0]?.width).toBe(NODE_MIN.chafa.width);
		expect(plans[0]?.image).toBe("");
	});
});

describe("plansForWidth", () => {
	const base: ChafaPlan[] = [
		{ key: "root.0.0", path: "root.0.0", image: "/tmp/x.gif", args: [], width: 43, height: 12 },
	];

	test("re-solves every canvas for the narrower box and keeps the aspect", () => {
		const plans = plansForWidth(DEFAULT_LAYOUT, SETTINGS, 60, base, "/tmp/x.gif", []);
		const plan = planForPath(plans, "root.0.0");
		expect(plan?.width).toBe(29); // (60 - gap) / 2
		// 12/43 of 29 rows: the picture scales down, it is not cropped
		expect(plan?.height).toBe(Math.round(29 * (12 / 43)));
	});

	test("a bigger box scales up from the same ratio", () => {
		const plans = plansForWidth(DEFAULT_LAYOUT, SETTINGS, 100, base, "/tmp/x.gif", []);
		const plan = planForPath(plans, "root.0.0");
		expect(plan?.width).toBe(49);
		expect(plan?.height).toBe(Math.round(49 * (12 / 43)));
	});

	test("never goes below the chafa floor and leaves unknown nodes alone", () => {
		const plans = plansForWidth(DEFAULT_LAYOUT, SETTINGS, 24, base, "/tmp/x.gif", []);
		expect(planForPath(plans, "root.0.0")?.height).toBeGreaterThanOrEqual(NODE_MIN.chafa.height);
		const orphan: ChafaPlan[] = [
			{ key: "root.9", path: "root.9", image: "/tmp/x.gif", args: [], width: 43, height: 12 },
		];
		const kept = plansForWidth(DEFAULT_LAYOUT, SETTINGS, 60, orphan, "/tmp/x.gif", []);
		// No base plan for that path: the width-derived height is a fine fallback.
		expect(planForPath(kept, "root.9")).toBeUndefined();
	});
});

describe("distribute", () => {
	test("solves the default splash from the configured box", () => {
		const plans = planChafaNodes(DEFAULT_LAYOUT, SETTINGS, "~/art.gif", []);
		const boxes = distribute(DEFAULT_LAYOUT, { width: 88, height: 50 }, SETTINGS, plans);
		expect(box(boxes, "root")).toEqual({ width: 88, height: 50 });
		expect(box(boxes, "root.0")).toEqual({ width: 43, height: 50 });
		expect(box(boxes, "root.1")).toEqual({ width: 43, height: 50 });
		const left = box(boxes, "root.0");
		const right = box(boxes, "root.1");
		expect(left.width + SETTINGS.gap.width + right.width).toBe(88);
		// The canvas is rigid: it keeps the planned height, the window takes the rest.
		expect(box(boxes, "root.0.0")).toEqual({ width: 43, height: autoHeightFor(43) });
		// Vertical gap, not the horizontal one: rows and columns are configured apart.
		expect(box(boxes, "root.0.1").height).toBe(50 - autoHeightFor(43) - SETTINGS.gap.height);
	});

	test("content need is measured at the allocated width", () => {
		const plans = planChafaNodes(DEFAULT_LAYOUT, SETTINGS, "~/art.gif", []);
		const widths: number[] = [];
		distribute(DEFAULT_LAYOUT, { width: 88, height: 50 }, SETTINGS, plans, (_node, width) => {
			widths.push(width);
			return { minHeight: 3, prefHeight: 6, minWidth: 12, prefWidth: 40 };
		});
		expect(widths).toContain(43);
		expect(widths.every((width) => width > 0)).toBe(true);
	});

	test("a box narrower than the minimums throws a LayoutError with the node path", () => {
		const plans = planChafaNodes(DEFAULT_LAYOUT, SETTINGS, "~/art.gif", []);
		let error: unknown;
		try {
			distribute(DEFAULT_LAYOUT, { width: 20, height: 50 }, SETTINGS, plans);
		} catch (thrown) {
			error = thrown;
		}
		expect(error).toBeInstanceOf(LayoutError);
		const layoutError = error as LayoutError;
		expect(layoutError.nodePath).toBe("root.0");
		expect(layoutError.message).toContain("12 columns");
	});

	test("a box shorter than the minimums throws a LayoutError too", () => {
		const plans = planChafaNodes(DEFAULT_LAYOUT, SETTINGS, "~/art.gif", []);
		let error: unknown;
		try {
			// 2 (canvas floor) + 3 (window floor) = 5 rows is the smallest column.
			distribute(DEFAULT_LAYOUT, { width: 88, height: 4 }, SETTINGS, plans);
		} catch (thrown) {
			error = thrown;
		}
		expect(error).toBeInstanceOf(LayoutError);
		expect((error as LayoutError).nodePath).toBe("root.0");
		expect((error as LayoutError).message).toContain("rows");
	});
});

describe("structural errors", () => {
	const withRoot = (node: unknown) => node as LayoutGroup;

	test("an unknown node type is reported with its node path", () => {
		const tree = withRoot({
			type: "layout",
			weight: 1,
			mode: "horizontal",
			children: [
				{ type: "chafa", weight: 1 },
				{ type: "window", weight: 1, content: [] },
				{ type: "sparkline", weight: 1 },
			],
		});
		let error: unknown;
		try {
			planChafaNodes(tree, SETTINGS, "~/art.gif", []);
		} catch (thrown) {
			error = thrown;
		}
		expect(error).toBeInstanceOf(LayoutError);
		expect((error as LayoutError).nodePath).toBe("root.2");
		expect((error as LayoutError).message).toContain("expected one of chafa, layout, window");
	});

	test("a group without children is rejected", () => {
		const tree = withRoot({ type: "layout", weight: 1, mode: "vertical", children: [] });
		expect(() => planChafaNodes(tree, SETTINGS, undefined, [])).toThrow(/layout needs at least one child/);
		expect(() => distribute(tree, { width: 80, height: 40 }, SETTINGS, [])).toThrow(LayoutError);
	});

	test("a window without content is rejected", () => {
		const tree = withRoot({ type: "window", weight: 1, title: "X" });
		expect(() => planChafaNodes(tree, SETTINGS, undefined, [])).toThrow(/window needs a content array/);
		let error: unknown;
		try {
			distribute(tree, { width: 80, height: 40 }, SETTINGS, []);
		} catch (thrown) {
			error = thrown;
		}
		expect(error).toBeInstanceOf(LayoutError);
		expect((error as LayoutError).nodePath).toBe("root");
	});

	test("an invalid weight is rejected instead of defaulted", () => {
		for (const weight of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
			const tree = withRoot({ type: "chafa", weight });
			expect(() => planChafaNodes(tree, SETTINGS, undefined, [])).toThrow(/weight must be a positive number/);
		}
		const missing = withRoot({ type: "chafa" });
		expect(planChafaNodes(missing, SETTINGS, "~/art.gif", []).length).toBe(1);
	});

	test("a non-object node is rejected", () => {
		expect(() => planChafaNodes(withRoot(null), SETTINGS, undefined, [])).toThrow(/expected an object/);
		expect(() => distribute(withRoot("chafa"), { width: 80, height: 40 }, SETTINGS, [])).toThrow(LayoutError);
	});

	test("distribute reports structure even when no chafa plan exists", () => {
		const tree = withRoot({
			type: "layout",
			weight: 1,
			mode: "vertical",
			children: [{ type: "mystery", weight: 1 }],
		});
		let error: unknown;
		try {
			distribute(tree, { width: 80, height: 40 }, SETTINGS, []);
		} catch (thrown) {
			error = thrown;
		}
		expect(error).toBeInstanceOf(LayoutError);
		expect((error as LayoutError).nodePath).toBe("root.0");
	});
});

describe("measureTree", () => {
	test("default tree is flexible and reports the sum of its columns", () => {
		const plans = planChafaNodes(DEFAULT_LAYOUT, SETTINGS, "~/art.gif", []);
		const measure = measureTree(DEFAULT_LAYOUT, SETTINGS, plans);
		expect(measure.flexible).toBe(true);
		// The left column's minimum width is its widest child (the info window).
		expect(measure.minWidth).toBe(NODE_MIN.window.width + SETTINGS.gap.width + NODE_MIN.window.width);
		expect(measure.minHeight).toBe(NODE_MIN.chafa.height + SETTINGS.gap.height + NODE_MIN.window.height);
		expect(measure.prefWidth).toBe(43 + SETTINGS.gap.width + NODE_MIN.window.width);
	});

	test("window height comes from the content callback", () => {
		const plans = planChafaNodes(DEFAULT_LAYOUT, SETTINGS, "~/art.gif", []);
		const measure = measureTree(DEFAULT_LAYOUT, SETTINGS, plans, () => ({
			minHeight: 3,
			prefHeight: 5,
			minWidth: 12,
			prefWidth: 30,
		}));
		expect(measure.prefHeight).toBe(autoHeightFor(43) + SETTINGS.gap.height + 5);
	});

	test("window width preferences come from the content callback too", () => {
		const plans = planChafaNodes(DEFAULT_LAYOUT, SETTINGS, "~/art.gif", []);
		const measure = measureTree(DEFAULT_LAYOUT, SETTINGS, plans, () => ({
			minHeight: 3,
			prefHeight: 5,
			minWidth: 20,
			prefWidth: 30,
		}));
		expect(measure.minWidth).toBe(20 + SETTINGS.gap.width + 20);
		expect(measure.prefWidth).toBe(43 + SETTINGS.gap.width + 30);
	});

	test("garbage from the content callback falls back to the node minimum", () => {
		const plans = planChafaNodes(DEFAULT_LAYOUT, SETTINGS, "~/art.gif", []);
		const measure = measureTree(DEFAULT_LAYOUT, SETTINGS, plans, () => ({
			minHeight: Number.NaN,
			prefHeight: -4,
			minWidth: Number.NaN,
			prefWidth: 0,
		}));
		expect(measure.minWidth).toBe(NODE_MIN.window.width + SETTINGS.gap.width + NODE_MIN.window.width);
		expect(measure.minHeight).toBe(NODE_MIN.chafa.height + SETTINGS.gap.height + NODE_MIN.window.height);
	});
});

describe("content providers", () => {
	const ctx: ContentContext = {
		gifPath: "~/art.gif",
		version: "1.5.2",
		model: "Claude Sonnet 4.5",
		thinking: "high",
		context: ["AGENTS.md"],
		skills: ["btw", "workflow-patterns"],
		extensions: ["pi-btw:index.ts"],
	};

	test("version, context, skills and extensions return their values unshortened", () => {
		expect(resolveContent("version", ctx)).toEqual({ value: "1.5.2" });
		expect(resolveContent("context", ctx)).toEqual({ value: "AGENTS.md", names: ["AGENTS.md"] });
		expect(resolveContent("skills", ctx)).toEqual({ value: "btw, workflow-patterns", names: ["btw", "workflow-patterns"] });
		expect(resolveContent("extensions", ctx)).toEqual({ value: "pi-btw:index.ts", names: ["pi-btw:index.ts"] });
	});

	test("model carries the thinking level as a truncation-proof suffix", () => {
		expect(resolveContent("model", ctx)).toEqual({ value: "Claude Sonnet 4.5", suffix: "· high" });
		expect(resolveContent("model", { ...ctx, thinking: "unknown" })).toEqual({ value: "Claude Sonnet 4.5" });
	});

	test("registered providers are resolved, unknown names stay literal", () => {
		registerProvider("test-frame-count", (context) => context.frameCount ?? "pending");
		expect(resolveContent("test-frame-count", { ...ctx, frameCount: "3/8" })).toEqual({ value: "3/8" });
		expect(PROVIDERS["test-frame-count"]).toBeDefined();
		expect(resolveContent("just a literal", ctx)).toEqual({ value: "just a literal" });
		expect(resolveContent("pi-chafa-banner", ctx)).toEqual({ value: "pi-chafa-banner" });
	});

	test("providers may return a string, a list or a value with suffix", () => {
		registerProvider("test-list", () => ["a", "b"]);
		registerProvider("test-value", () => ({ value: "x", suffix: "· y" }));
		expect(resolveContent("test-list", ctx)).toEqual({ value: "a, b", names: ["a", "b"] });
		expect(resolveContent("test-value", ctx)).toEqual({ value: "x", suffix: "· y" });
	});
});
