import { describe, expect, test } from "bun:test";
import type { ContentContext } from "../src/content.ts";
import type { FrameSet } from "../src/frames.ts";
import {
	configPathOf,
	cropFrame,
	distribute,
	measureContent,
	NODE_MIN,
	plainPainter,
	placeholderCard,
	renderLayoutError,
	renderNode,
	renderSplash,
	type ChafaPlan,
	type ContentSpec,
	type LayoutNode,
	type RenderContext,
	type SplashSettings,
	type WindowNode,
} from "../src/layout.ts";
import { visibleWidth } from "../src/text.ts";

const CONTENT: ContentContext = {
	gifPath: "/tmp/banner.gif",
	version: "1.5.2",
	model: "Claude Sonnet 4.5",
	thinking: "high",
	context: ["AGENTS.md", "CLAUDE.md"],
	skills: ["btw", "workflow-authoring"],
	extensions: ["pi-btw:index.ts", "pi-dynamic-workflows:index.ts"],
};

const SETTINGS: SplashSettings = {
	width: 60,
	height: 12,
	gap: { width: 2, height: 0 },
	variableWidth: false,
	variableHeight: true,
	compactWidth: 32,
};

function contextWith(overrides: Partial<RenderContext> = {}): RenderContext {
	return {
		painter: plainPainter,
		plans: [],
		frames: new Map<string, FrameSet>(),
		frameIndex: 0,
		content: CONTENT,
		settings: SETTINGS,
		...overrides,
	};
}

function node(content: ContentSpec[], title = "CARD"): WindowNode {
	return { type: "window", weight: 1, title, content };
}

function versionNode(title = "CARD"): WindowNode {
	return node([{ type: "inline", title: "Version", content: "version" }], title);
}

function frameSet(frames: string[][]): FrameSet {
	return {
		frames,
		width: 12,
		height: frames[0]?.length ?? 0,
		colorMode: "truecolor",
		gifPath: "/tmp/banner.gif",
		totalFrames: frames.length,
		stride: 1,
		delays: frames.map(() => 100),
		fromCache: true,
		builtAt: 0,
	};
}

/** Frames whose first row says which frame it is: `r0..........`. */
function rows(label: string, count: number): string[] {
	return Array.from({ length: count }, (_, row) => `${label}${row}`.padEnd(12, "."));
}

function expectFits(lines: readonly string[], width: number): void {
	for (const line of lines) {
		expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		expect(line).not.toContain("\n");
	}
}

describe("measureContent", () => {
	test("reports the content's natural width, minimums and row count", () => {
		const card = node([
			{ type: "inline", title: "Version", content: "version" },
			{ type: "inline", title: "Model", content: "model" },
		]);
		const measure = measureContent(card, 12, contextWith());
		expect(measure.minWidth).toBe(NODE_MIN.window.width);
		expect(measure.minHeight).toBe(NODE_MIN.window.height);
		// widest row is `[Model] Claude Sonnet 4.5 · high`, plus borders/padding
		expect(measure.prefWidth).toBe(4 + visibleWidth("[Model] Claude Sonnet 4.5 · high"));
		expect(measure.prefHeight).toBe(4); // two rows plus the two borders
		expect(measure.flexible).toBe(true);
	});

	test("list content asks for the width of its un-wrapped form", () => {
		const resources = node([{ type: "outline", title: "Context", content: "context" }], "RESOURCES");
		const horizontal = measureContent(resources, 12, contextWith());
		expect(horizontal.prefWidth).toBe(4 + 2 + visibleWidth("AGENTS.md, CLAUDE.md"));

		const stacked = node([{ type: "outline", title: "Extensions", content: "extensions", stacked: true }], "RESOURCES");
		const vertical = measureContent(stacked, 12, contextWith());
		const widest = Math.max(...CONTENT.extensions.map((entry) => visibleWidth(entry)));
		expect(vertical.prefWidth).toBe(4 + 2 + widest);
	});
});

describe("window nodes", () => {
	test("render exactly box.height rows of exactly box.width columns", () => {
		const card = node([
			{ type: "inline", title: "Version", content: "version" },
			{ type: "inline", title: "Model", content: "model" },
		]);
		const lines = renderNode(card, "root", { width: 40, height: 6 }, contextWith());
		expect(lines).toHaveLength(6);
		for (const line of lines) expect(visibleWidth(line)).toBe(40);
		expect(lines[0]).toContain("╭");
		expect(lines[0]).toContain("CARD");
		expect(lines[1]).toContain("[Version] 1.5.2");
		expect(lines[2]).toContain("[Model] Claude Sonnet 4.5 · high");
		expect(lines[5]).toContain("╰");
	});

	test("the thinking level survives a long model name", () => {
		const long = node([{ type: "inline", title: "Model", content: "model" }]);
		const ctx = contextWith({ content: { ...CONTENT, model: "Some Extremely Long Model Name That Will Not Fit" } });
		const lines = renderNode(long, "root", { width: 30, height: 4 }, ctx);
		expect(lines[1]).toContain("...");
		expect(lines[1]).toContain("· high");
	});

	test("outline content puts the heading on its own row", () => {
		const card = node(
			[
				{ type: "outline", title: "Context", content: "context" },
				{ type: "outline", title: "Version", content: "literal value" },
			],
			"WINDOW",
		);
		const lines = renderNode(card, "root", { width: 40, height: 6 }, contextWith());
		expect(lines[1]).toContain("[Context]");
		expect(lines[2]).toContain("AGENTS.md, CLAUDE.md");
		// a literal that matches no provider is printed as-is
		expect(lines[3]).toContain("[Version]");
		expect(lines[4]).toContain("literal value");
	});

	test("stacked lists get one row each, plain lists wrap with commas", () => {
		const resources = node(
			[
				{ type: "outline", title: "Extensions", content: "extensions", stacked: true },
				{ type: "outline", title: "Skills", content: "skills" },
			],
			"RESOURCES",
		);
		const lines = renderNode(resources, "root", { width: 50, height: 8 }, contextWith());
		expect(lines[1]).toContain("[Extensions]");
		expect(lines[2]).toContain("pi-btw:index.ts");
		expect(lines[2]).not.toContain(",");
		expect(lines[3]).toContain("pi-dynamic-workflows:index.ts");
		expect(lines[4]).toContain("[Skills]");
		expect(lines[5]).toContain("btw, workflow-authoring");
	});

	test("absorbs spare height and keeps the border rows aligned", () => {
		const card = versionNode();
		const lines = renderNode(card, "root", { width: 30, height: 10 }, contextWith());
		expect(lines).toHaveLength(10);
		for (const line of lines) expect(visibleWidth(line)).toBe(30);
		expect(lines[0][0]).toBe("╭");
		expect(lines[9][0]).toBe("╰");
		expect(lines[5]).toBe("│" + " ".repeat(28) + "│");
	});

	test("marks the cut with `...` for a dropped heading and `  ...` for a dropped item", () => {
		const card = node([
			{ type: "outline", title: "Context", content: "context" },
			{ type: "outline", title: "Skills", content: "skills", stacked: true },
		]);
		const fixed = { ...SETTINGS, variableHeight: false };
		// Height 6 -> 4 content rows: the section survives, the second name is cut.
		const itemCut = renderNode(card, "root", { width: 30, height: 6 }, contextWith({ settings: fixed }));
		expect(itemCut[4]).toContain("  ...");
		// Height 5 -> 3 content rows: the next row would have been `[Skills]` itself.
		const headingCut = renderNode(card, "root", { width: 30, height: 5 }, contextWith({ settings: fixed }));
		expect(headingCut[3]!.trimEnd()).toBe("│ ..." + " ".repeat(24) + "│");
	});

	test("the overflow mark keeps the indentation of the row it replaces", () => {
		const card = node([
			{ type: "inline", title: "Version", content: "version" },
			{ type: "inline", title: "Model", content: "model" },
			{ type: "inline", title: "Gif", content: "gif" },
		]);
		const fixed = { ...SETTINGS, variableHeight: false };
		// Inline fields start at the border, so the mark does too — no stray indent.
		const lines = renderNode(card, "root", { width: 30, height: 4 }, contextWith({ settings: fixed }));
		expect(lines[2]!.trimEnd()).toBe("│ ..." + " ".repeat(24) + "│");
	});

	test("variableHeight clips silently instead of marking the cut", () => {
		const card = node([
			{ type: "outline", title: "Context", content: "context" },
			{ type: "outline", title: "Skills", content: "skills", stacked: true },
		]);
		const lines = renderNode(card, "root", { width: 30, height: 5 }, contextWith());
		expect(lines.join("\n")).not.toContain("...");
	});

	test("a window without a title still gets a heading", () => {
		const untitled: WindowNode = { type: "window", weight: 1, content: [{ type: "inline", title: "Version", content: "version" }] };
		const lines = renderNode(untitled, "root", { width: 30, height: 4 }, contextWith());
		expect(lines[0]).toContain("WINDOW");
	});
});

describe("chafa nodes", () => {
	test("render the IMAGE placeholder while the frames are missing", () => {
		const chafa: LayoutNode = { type: "chafa", weight: 1 };
		const lines = renderNode(chafa, "root.0", { width: 40, height: 5 }, contextWith());
		expect(lines).toHaveLength(5);
		expectFits(lines, 40);
		expect(lines[0]).toContain("IMAGE");
		expect(lines[1]).toContain("rendering chafa frames");
		expect(lines[4].trim()).toBe("");
	});

	test("show the failure reason inside the placeholder", () => {
		const chafa: LayoutNode = { type: "chafa", weight: 1 };
		const lines = renderNode(chafa, "root.0", { width: 44, height: 5 }, contextWith({ status: "chafa: command not found" }));
		expect(lines[1]).toContain("unavailable: chafa: command not found");
	});

	test("crop frames from the top, center them, and follow frameIndex", () => {
		const plan: ChafaPlan = { key: "root.0", path: "root.0", image: "/tmp/banner.gif", args: [], width: 20, height: 8 };
		const frames = new Map<string, FrameSet>([
			["root.0", frameSet([rows("a", 12), rows("b", 12)])],
		]);
		const chafa: LayoutNode = { type: "chafa", weight: 1 };
		const base = contextWith({ plans: [plan], frames });

		const first = renderNode(chafa, "root.0", { width: 8, height: 3 }, base);
		expect(first).toHaveLength(3);
		for (const line of first) expect(visibleWidth(line)).toBe(8);
		expect(first[0]).toContain("a0");
		expect(first[2]).toContain("a2");
		expect(first[0]).not.toContain("a1");

		const second = renderNode(chafa, "root.0", { width: 8, height: 3 }, { ...base, frameIndex: 1 });
		expect(second[0]).toContain("b0");

		// negative / oversized indexes wrap instead of throwing
		const wrapped = renderNode(chafa, "root.0", { width: 8, height: 2 }, { ...base, frameIndex: -1 });
		expect(wrapped[0]).toContain("b0");
	});

	test("cropFrame centers narrower artwork and clips wider artwork", () => {
		const narrow = cropFrame(["ab", "cd"], 8, 2);
		expect(narrow).toHaveLength(2);
		for (const line of narrow) expect(visibleWidth(line)).toBeLessThanOrEqual(8);
		expect(narrow[0]?.trim()).toBe("ab");
		expect(narrow[0]?.startsWith(" ")).toBe(true);

		const wide = cropFrame(["-".repeat(20)], 6, 1);
		expect(wide[0]).toBe("------");

		expect(cropFrame(["a"], 4, 0)).toEqual([]);
	});

	test("placeholderCard keeps the requested footprint", () => {
		const lines = placeholderCard(plainPainter, undefined, 12, 6);
		expect(lines).toHaveLength(6);
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(12);
		expect(lines[0]).toContain("IMAGE");
	});
});

describe("layout nodes", () => {
	test("horizontal groups split the width by weight and keep the gap", () => {
		const group: LayoutNode = {
			type: "layout",
			weight: 1,
			mode: "horizontal",
			children: [versionNode("LEFT"), versionNode("RIGHT")],
		};
		const lines = renderNode(group, "root", { width: 40, height: 5 }, contextWith());
		expect(lines).toHaveLength(5);
		for (const line of lines) expect(visibleWidth(line)).toBe(40);
		// 40 - gap(2) = 38 -> 19 columns each
		expect(lines[0]?.[0]).toBe("╭");
		expect(lines[0]?.[18]).toBe("╮");
		expect(lines[0]?.slice(19, 21)).toBe("  ");
		expect(lines[0]?.[21]).toBe("╭");
		expect(lines[0]?.slice(22, 40)).toContain("RIGHT");
	});

	test("vertical groups insert exactly gap blank rows between children", () => {
		const group: LayoutNode = {
			type: "layout",
			weight: 1,
			mode: "vertical",
			children: [versionNode("TOP"), versionNode("BOTTOM")],
		};
		// Rows are separate from columns: 2 blank rows here, 2 blank columns in
		// the horizontal case above.
		const lines = renderNode(
			group,
			"root",
			{ width: 30, height: 12 },
			contextWith({ settings: { ...SETTINGS, gap: { width: 2, height: 2 } } }),
		);
		expect(lines).toHaveLength(12);
		for (const line of lines) expect(visibleWidth(line)).toBe(30);
		expect(lines[0]).toContain("TOP");
		// 12 - 2 = 10 rows -> 5 per child, two blank rows between them.
		expect(lines[5]?.trim()).toBe("");
		expect(lines[6]?.trim()).toBe("");
		expect(lines[7]).toContain("BOTTOM");
	});

	test("no blank rows by default: gap.height is 0", () => {
		const group: LayoutNode = {
			type: "layout",
			weight: 1,
			mode: "vertical",
			children: [versionNode("TOP"), versionNode("BOTTOM")],
		};
		const lines = renderNode(group, "root", { width: 30, height: 12 }, contextWith());
		expect(lines).toHaveLength(12);
		// 12 / 2 = 6 rows each, no separator rows.
		expect(lines[5]).toContain("╰");
		expect(lines[6]).toContain("BOTTOM");
	});

	test("distribute honours a global path prefix", () => {
		const group: LayoutNode = {
			type: "layout",
			weight: 1,
			mode: "horizontal",
			children: [versionNode(), versionNode()],
		};
		const boxes = distribute(group, { width: 40, height: 5 }, SETTINGS, [], undefined, [0]);
		expect(boxes.get("root.0.0")).toEqual({ width: 19, height: 5 });
		expect(boxes.get("root.0.1")).toEqual({ width: 19, height: 5 });
	});
});

describe("renderSplash", () => {
	const single: LayoutNode = {
		type: "layout",
		weight: 1,
		mode: "vertical",
		children: [versionNode()],
	};

	test("height is a floor: spare rows stay blank instead of shrinking the block", () => {
		const ctx = contextWith({ settings: { ...SETTINGS, width: 40, height: 12 } });
		const lines = renderSplash(single, ctx, { width: 100, height: 40 });
		expect(lines).toHaveLength(12);
		expectFits(lines, 100);
		// 40-wide block centered in 100 columns: 30 columns of left padding
		expect(lines[0]?.startsWith(" ".repeat(30) + "╭")).toBe(true);
		expect(lines[11]).toContain("╰");
	});

	test("height: auto asks for exactly the rows the content needs", () => {
		const ctx = contextWith({ settings: { ...SETTINGS, width: 40, height: null } });
		const lines = renderSplash(single, ctx, { width: 100, height: 40 });
		// one window: two borders plus the single content row
		expect(lines).toHaveLength(3);
		expectFits(lines, 100);
	});

	test("a narrower terminal re-plans the canvas instead of cropping it", () => {
		const path = "root.0";
		const tree: LayoutNode = {
			type: "layout",
			weight: 1,
			mode: "horizontal",
			children: [{ type: "chafa", weight: 5 }, { ...versionNode(), weight: 5 }],
		};
		const plans: ChafaPlan[] = [
			{ key: path, path, image: "/tmp/banner.gif", args: [], width: 29, height: 8 },
		];
		const requested: number[] = [];
		const ctx = contextWith({
			plans,
			frames: new Map<string, FrameSet>([[path, frameSet([rows("a", 8)])]]),
			planWidth: 29,
			settings: { ...SETTINGS, height: null },
			onWidth: (width) => requested.push(width),
		});
		// 40 columns: two 19-wide columns. The canvas keeps the 8/29 aspect ratio of the
		// configured one, so it drops to 5 rows: the block gets shorter instead of
		// showing the 8-row artwork clipped to 19 columns. Horizontal group, so the
		// block is as tall as the taller column.
		const lines = renderSplash(tree, ctx, { width: 40, height: 40 });
		expect(requested).toEqual([40]);
		expectFits(lines, 40);
		expect(lines).toHaveLength(5);
	});

	test("variableHeight=false clips the window and marks the cut with an ellipsis", () => {
		const resources: LayoutNode = {
			type: "layout",
			weight: 1,
			mode: "vertical",
			children: [
				node(
					[
						{ type: "outline", title: "Context", content: "context" },
						{ type: "outline", title: "Skills", content: "skills" },
						{ type: "outline", title: "Extensions", content: "extensions", stacked: true },
					],
					"RESOURCES",
				),
			],
		};
		const ctx = contextWith({ settings: { ...SETTINGS, width: 40, height: 6, variableHeight: false } });
		const lines = renderSplash(resources, ctx, { width: 100, height: 40 });
		expect(lines).toHaveLength(6);
		expectFits(lines, 100);
		expect(lines[4]).toContain("...");
		expect(lines[5]).toContain("╰");
	});

	test("variableWidth=true grows the block to the content's natural width", () => {
		const wide = node([{ type: "outline", title: "Note", content: "x".repeat(60) }], "WIDE");
		const tree: LayoutNode = { type: "layout", weight: 1, mode: "vertical", children: [wide] };
		const ctx = contextWith({ settings: { ...SETTINGS, width: 40, height: 6, variableWidth: true } });
		const lines = renderSplash(tree, ctx, { width: 200, height: 40 });
		// natural width: 2-space indent + 60 columns of content + 4 border columns
		const pad = Math.floor((200 - 66) / 2);
		expect(lines[0]?.length).toBe(pad + 66);
		expect(lines[0]?.startsWith(" ".repeat(pad) + "╭")).toBe(true);
		expectFits(lines, 200);
	});

	test("variableWidth=false truncates content that is wider than the block", () => {
		const wide = node([{ type: "outline", title: "Note", content: "x".repeat(60) }], "WIDE");
		const tree: LayoutNode = { type: "layout", weight: 1, mode: "vertical", children: [wide] };
		const ctx = contextWith({ settings: { ...SETTINGS, width: 40, height: 6, variableWidth: false } });
		const lines = renderSplash(tree, ctx, { width: 60, height: 40 });
		expectFits(lines, 60);
		expect(lines[2]).toContain("...");
		// the block stays 40 columns wide and is centered in the 60-column terminal
		expect(lines[0]?.startsWith(" ".repeat(10) + "╭")).toBe(true);
		expect(visibleWidth(lines[0] ?? "")).toBe(50);
	});

	test("content taller than the viewport is clipped to the splash rows", () => {
		const specs = Array.from({ length: 20 }, (_, index) => ({
			type: "outline" as const,
			title: `Row ${index}`,
			content: "x",
		}));
		const tree: LayoutNode = {
			type: "layout",
			weight: 1,
			mode: "vertical",
			children: [node(specs, "TALL")],
		};
		const ctx = contextWith({ settings: { ...SETTINGS, width: 40, height: 10 } });
		const lines = renderSplash(tree, ctx, { width: 60, height: 20 });
		// splashRows(20) = 13: the splash never pushes the editor around
		expect(lines).toHaveLength(13);
		expectFits(lines, 60);
	});

	test("a terminal too narrow for boxes keeps the three-line compact splash", () => {
		const lines = renderSplash(single, contextWith(), { width: 24, height: 40 });
		expect(lines).toHaveLength(3);
		expectFits(lines, 24);
		expect(lines[0]).toContain("pi-chafa-banner");
	});

	test("the compact splash keeps the status, so a failure stays visible", () => {
		const ctx = contextWith({ status: "chafa: command not found" });
		const lines = renderSplash(single, ctx, { width: 24, height: 40 });
		expectFits(lines, 24);
		expect(lines).toHaveLength(4);
		expect(lines[3]).toContain("chafa: command not found");
	});

	test("line breaks and tabs in titles or values never reach a row", () => {
		const messy: LayoutNode = node(
			[
				{ type: "inline", title: "Ver\tsion", content: "version" },
				{ type: "inline", title: "Note", content: "first\nsecond" },
			],
			"CAR\nD",
		);
		const tree: LayoutNode = { type: "layout", weight: 1, mode: "vertical", children: [messy] };
		const lines = renderSplash(tree, contextWith({ settings: { ...SETTINGS, width: 40, height: 8 } }), {
			width: 100,
			height: 40,
		});
		expect(lines).toHaveLength(8);
		for (const line of lines) expect(line).not.toMatch(/[\n\t]/);
		expect(lines[0]).toContain("CAR D");
		expect(lines.join("\n")).toContain("first second");
	});

	test("a tight terminal crops the artwork instead of the info card", () => {
		const plan: ChafaPlan = { key: "root.0.0", path: "root.0.0", image: "/tmp/banner.gif", args: [], width: 40, height: 22 };
		const tree: LayoutNode = {
			type: "layout",
			weight: 1,
			mode: "vertical",
			children: [
				{ type: "chafa", weight: 1 },
				node(
					[
						{ type: "inline", title: "Version", content: "version" },
						{ type: "inline", title: "Model", content: "model" },
					],
					"CODING AGENT",
				),
			],
		};
		const ctx = contextWith({
			plans: [plan],
			frames: new Map([[plan.key, frameSet([rows("a", 22)])]]),
			status: "frames 8/8",
			settings: { ...SETTINGS, width: 40, height: 12 },
		});
		const lines = renderSplash(tree, ctx, { width: 40, height: 16 });
		const text = lines.join("\n");
		// A 16-row terminal leaves 9 rows: the card keeps its two rows and the
		// artwork gives up the cells, so the text is never squeezed into "…".
		expect(text).toContain("[Version]");
		expect(text).toContain("[Model]");
		expectFits(lines, 40);
	});

	test("a status line is appended inside the same viewport budget", () => {
		const ctx = contextWith({ status: "engine: chafa missing", settings: { ...SETTINGS, width: 40, height: 12 } });
		const lines = renderSplash(single, ctx, { width: 100, height: 20 });
		// splashRows(20) = 13 -> root 12 + status 1
		expect(lines).toHaveLength(13);
		expectFits(lines, 100);
		expect(lines[12]).toContain("engine: chafa missing");
	});

	test("a box that cannot host its children renders the error card, not an exception", () => {
		const group: LayoutNode = {
			type: "layout",
			weight: 1,
			mode: "vertical",
			children: [versionNode(), versionNode()],
		};
		const ctx = contextWith({ settings: { ...SETTINGS, width: 60, height: 4, variableHeight: false } });
		const lines = renderSplash(group, ctx, { width: 100, height: 40 });
		const text = lines.join("\n");
		expect(text).toContain("LAYOUT ERROR");
		expect(text).toContain("layout.children[0]");
		expect(text).toContain("needs at least 3 rows");
		expectFits(lines, 100);
	});

	test("a structural error uses the JSON path of the offending node", () => {
		const broken = { type: "chart", weight: 1 } as unknown as LayoutNode;
		const lines = renderSplash(broken, contextWith(), { width: 100, height: 40 });
		const text = lines.join("\n");
		expect(text).toContain("LAYOUT ERROR");
		expect(text).toContain("layout:");
		expect(text).toContain("expected one of chafa, layout, window");
	});

	test("a broken child is reported with its JSON path", () => {
		const broken = {
			type: "layout",
			weight: 1,
			mode: "vertical",
			children: [versionNode(), { type: "chart", weight: 1 }],
		} as unknown as LayoutNode;
		const text = renderSplash(broken, contextWith(), { width: 100, height: 40 }).join("\n");
		expect(text).toContain("LAYOUT ERROR");
		expect(text).toContain("layout.children[1]");
	});
});

describe("error card", () => {
	test("lists every message line and keeps the card inside its width", () => {
		const card = renderLayoutError("layout.children[1].type: expected one of chafa, layout, window (got \"chart\")", 60, plainPainter);
		expect(card[0]).toContain("LAYOUT ERROR");
		const text = card.join("\n");
		expect(text).toContain("layout.children[1].type");
		expect(text).toContain('(got "chart")');
		expectFits(card, 60);
	});

	test("wraps a long reason instead of losing it", () => {
		const card = renderLayoutError("layout.children[0]: needs at least 12 columns, only 9 available", 40, plainPainter);
		const body = card.slice(1, -1).join(" ");
		expect(body).toContain("layout.children[0]");
		expect(body).toContain("12 columns");
		expect(body).toContain("9 available");
	});

	test("multiple problems become multiple shows", () => {
		const card = renderLayoutError("layout.children[0]: bad\nlayout.children[1]: worse", 60, plainPainter);
		const text = card.join("\n");
		expect(text).toContain("layout.children[0]: bad");
		expect(text).toContain("layout.children[1]: worse");
	});

	test("a card narrower than the message still respects the width", () => {
		const card = renderLayoutError("layout.children[12].weight: expected a positive number", 12, plainPainter);
		expectFits(card, 12);
		expect(card.length).toBeGreaterThan(2);
	});

	test("maxRows keeps a long reason inside the viewport budget", () => {
		const message = Array.from({ length: 12 }, (_, index) => `layout.children[${index}]: needs at least 12 columns`).join("\n");
		const card = renderLayoutError(message, 60, plainPainter, 5);
		expect(card).toHaveLength(5);
		expect(card[3]).toContain("...");
		expect(card[4]).toContain("╰");
		expectFits(card, 60);
	});

	test("breaks a long token at a separator instead of mid-identifier", () => {
		const card = renderLayoutError("layout.children[0].type: expected one of chafa, layout, window (got \"chart\")", 30, plainPainter);
		// No row may end in the middle of `type:` — the colon stays with its word.
		const rowsWithoutBorder = card.slice(1, -1).map((line) => line.trim().replace(/^│|│$/g, "").trim());
		expect(rowsWithoutBorder.some((row) => row.endsWith(":"))).toBe(true);
		expectFits(card, 30);
	});
});

describe("configPathOf", () => {
	test("maps node paths back to the JSON path a user has to edit", () => {
		expect(configPathOf("root")).toBe("layout");
		expect(configPathOf("root.0")).toBe("layout.children[0]");
		expect(configPathOf("root.0.1")).toBe("layout.children[0].children[1]");
		expect(configPathOf("root.0.content[2]")).toBe("layout.children[0].content[2]");
	});
});
