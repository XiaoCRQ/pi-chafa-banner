/**
 * Shapes, defaults and hard limits for `pi-chafa-banner.json`.
 *
 * Everything the user can tune lives in the JSON file next to the package (see
 * `load.ts`); this module owns the *shape* of those knobs so validation, tests
 * and docs can share one description. No I/O here.
 */

import type { ChafaPlan, LayoutGroup, LayoutNode, SplashSettings } from "../layout/tree.ts";

export interface BannerSize {
	width: number;
	height: number;
}

/** Which facts the info card may show. */
export type PanelField = "version" | "model" | "gif" | "frames";

/** Which blocks the RESOURCES panel may show, in file order. */
export type ResourceSectionId = "context" | "skills" | "extensions";

export type AutoSize = number | "auto";

/** Root height: `"auto"` = exactly as tall as the content needs. */
export type HeightSetting = number | "auto";

/** `"auto"` = the gif's own timing, a number = fixed frames per second. */
export type RateSetting = number | "auto";

/**
 * Where the splash colours come from.
 *
 * `"tokyonight"` (the default) pins the built-in dark palette, so the splash
 * looks the same everywhere; every role stays overridable. `"pi"` follows the
 * active pi theme instead, which is what light terminals want.
 */
export type ThemePreset = "pi" | "tokyonight";

/** The four colour roles a user can point at their own hex values. */
export type ThemeRole = "windowTitle" | "sectionTitle" | "border" | "content";

/**
 * Colours for the boxes. Every role is optional: an unset role falls back to the
 * preset — `"tokyonight"` (`TOKYONIGHT_PALETTE`, the default) or `"pi"` to
 * follow pi's theme tokens instead (theme-aware, lighter).
 */
export interface ThemeSettings {
	preset: ThemePreset;
	/** Box titles: `RESOURCES`, `CODING AGENT`, `IMAGE`. */
	windowTitle?: string;
	/** Section headings: `[Context]`, `[Skills]`, and the info card's `[Version]` / `[Model]`. */
	sectionTitle?: string;
	/** Box borders and the dashes either side of a title. */
	border?: string;
	/** Body text: values, names, the status line. */
	content?: string;
}

export interface ImageSettings {
	path: string | undefined;
	fps: RateSetting;
	stride: number;
	/** Extra chafa arguments, exactly as the user typed them. */
	chafa: string;
}

/**
 * Legacy layout knobs, kept as a resolved mirror so the current renderer keeps
 * compiling while it is ported to the layout tree. New configs never set these;
 * `splash` and `layoutTree` are the source of truth.
 */
export interface LayoutSettings {
	/** Overall splash width in cells; each of the two columns gets half of it. */
	width: number;
	/** Blank columns between the picture/info column and the resource panel. */
	gap: number;
	/** Below this width the lower block stacks instead of splitting. */
	twoColumnMinWidth: number;
	/** Below this width the splash degrades to three plain lines. */
	compactMinWidth: number;
	/** Absolute ceiling, whatever the terminal reports. */
	maxWidth: number;
	/** Rows the lower block may use. */
	lowerRows: number;
}

export interface PanelsSettings {
	info: { enabled: boolean; fields: PanelField[] };
	resources: {
		enabled: boolean;
		sections: ResourceSectionId[];
		/** `auto` = whatever the layout leaves over. */
		width: AutoSize;
		/** `auto` = grow with the content (clipped at the document body). */
		height: AutoSize;
		maxLinesPerSection: number;
	};
}

/**
 * Flat, fully-resolved config consumed by the renderer and pipelines.
 *
 * Nested groups mirror the JSON file; the flat fields are resolved aliases so
 * call sites do not have to walk three levels for `fps`.
 */
export interface BannerConfig {
	version: 2;
	gifPath: string | undefined;
	/**
	 * Canvas of the first chafa node — the frames pipeline renders exactly this.
	 * Never configured directly: it falls out of the tree, weights and gap.
	 */
	size: BannerSize;
	fps: RateSetting;
	stride: number;
	/** Parsed `image.chafa` argv, ready to append to the pipeline's own flags. */
	chafaArgs: string[];
	static: boolean;
	enabled: boolean;
	/** Detach pi's own `[Context]/[Skills]/…` listing below the splash. */
	hideResources: boolean;
	/** Root box semantics: width/height/gap and the variable-size flags. */
	splash: SplashSettings;
	/** Parsed recursive layout; undefined exactly when `layoutError` is set. */
	layoutTree: LayoutNode | undefined;
	/** Structural config error, rendered as a `LAYOUT ERROR` card (never thrown). */
	layoutError: string | undefined;
	/** One canvas per chafa node, solved from config + weights + gap. */
	plans: ChafaPlan[];
	/**
	 * Box width `plans` were solved for. The renderer compares it with the width
	 * the terminal allows and asks the session to rebuild when they differ.
	 */
	planWidth: number;
	/** Compatibility mirror of `splash` for the pre-tree renderer. */
	layout: LayoutSettings;
	/** Compatibility mirror, derived from `layoutTree`, for the pre-tree renderer. */
	panels: PanelsSettings;
	/** Palette: preset plus any per-role hex overrides. */
	theme: ThemeSettings;
	/** Where the values came from; surfaced by `/splash status`. */
	source: ConfigSource;
}

export interface ConfigSource {
	/** Absolute path of the JSON file that was read, if any. */
	path?: string;
	/** Field-level problems, already de-duplicated. */
	warnings: string[];
}

/**
 * Default splash: artwork above the coding-agent card on the left, the resource
 * list on the right — the layout this extension has always drawn.
 *
 * It lives here (not in `layout/tree.ts`) to keep the module graph acyclic:
 * `layout/tree.ts` imports `autoHeightFor` from this module, so this module may
 * only import types back. `layout/tree.ts` re-exports it for layout consumers.
 */
export const DEFAULT_LAYOUT: LayoutGroup = {
	type: "layout",
	weight: 1,
	mode: "horizontal",
	children: [
		{
			type: "layout",
			weight: 5,
			mode: "vertical",
			children: [
				{ type: "chafa", weight: 1 },
				{
					type: "window",
					weight: 1,
					title: "CODING AGENT",
					content: [
						{ type: "inline", title: "Version", content: "version" },
						{ type: "inline", title: "Model", content: "model" },
					],
				},
			],
		},
		{
			type: "window",
			weight: 5,
			title: "RESOURCES",
			content: [
				{ type: "outline", title: "Context", content: "context" },
				{ type: "outline", title: "Skills", content: "skills" },
				{ type: "outline", title: "Extensions", content: "extensions", stacked: true },
			],
		},
	],
};

/** Defaults as they appear in the JSON file. `null` path = "not configured". */
export const DEFAULT_FILE = {
	version: 2,
	image: {
		path: "~/Pictures/logo/v-3.gif",
		fps: "auto",
		stride: 3,
		chafa: "",
	},
	width: 88,
	/**
	 * Height floor. `"auto"` asks for exactly the rows the content needs; a number
	 * is a floor the content may raise (see `variableHeight`). 17 is the stock
	 * tree at `width: 88`: a 12-row canvas + 1 gap + the 4 rows of a two-entry
	 * `CODING AGENT` card, i.e. the card shows exactly its two rows and no blanks.
	 */
	height: 17,
	/**
	 * Blank cells between siblings, per axis. Separate values because a character
	 * cell is roughly twice as tall as it is wide: two columns look like one row.
	 */
	gap: { width: 2, height: 1 },
	variableWidth: false,
	variableHeight: false,
	compactWidth: 32,
	layout: DEFAULT_LAYOUT,
	theme: { preset: "tokyonight" },
	behavior: { enabled: true, static: false, hidePiResourceList: true },
} as const;

/**
 * Tokyo Night, reduced to the four roles the splash paints.
 *
 * Blue titles, purple section labels, a muted indigo border and the palette's
 * foreground for body text — same hierarchy as pi's theme tokens, one palette.
 */
export const TOKYONIGHT_PALETTE: Required<Omit<ThemeSettings, "preset">> = {
	windowTitle: "#7aa2f7",
	sectionTitle: "#bb9af7",
	border: "#3b4261",
	content: "#a9b1d6",
};

export const THEME_PRESETS: readonly ThemePreset[] = ["pi", "tokyonight"];
export const THEME_ROLES: readonly ThemeRole[] = ["windowTitle", "sectionTitle", "border", "content"];

/** Hard caps keep a typo from producing an unusable splash. */
export const LIMITS = {
	fps: { min: 1, max: 30 },
	stride: { min: 1, max: 10 },
	width: { min: 8, max: 160 },
	height: { min: 4, max: 80 },
	weight: { min: 1, max: 100 },
	compactWidth: { min: 20, max: 80 },
	layoutWidth: { min: 24, max: 200 },
	gap: { min: 0, max: 12 },
	lowerRows: { min: 4, max: 40 },
	maxLinesPerSection: { min: 1, max: 40 },
	panelWidth: { min: 16, max: 200 },
} as const;

export const PANEL_FIELDS: readonly PanelField[] = ["version", "model", "gif", "frames"];
export const RESOURCE_SECTIONS: readonly ResourceSectionId[] = ["context", "skills", "extensions"];

export function clamp(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.min(max, Math.max(min, Math.round(value)));
}

export function formatSize(size: BannerSize): string {
	return `${size.width}x${size.height}`;
}

/** Columns one of the two side-by-side blocks gets out of `blockWidth`. */
export function columnWidthFor(blockWidth: number, gap: number): number {
	const usable = Math.max(2, Math.floor(blockWidth) - Math.max(0, Math.floor(gap)));
	return Math.max(1, Math.floor(usable / 2));
}

/** Rough height for a canvas width: a character cell is about twice as tall as wide. */
export function autoHeightFor(width: number): number {
	return clamp(Math.round(width / 2), LIMITS.height.min, LIMITS.height.max);
}

/**
 * The chafa canvas the pipeline renders at, derived from the layout alone: the
 * two columns are equal, so the artwork is exactly one column wide.
 */
export function derivedCanvas(layout: LayoutSettings): BannerSize {
	const block = Math.min(layout.maxWidth, layout.width);
	const width = clamp(columnWidthFor(block, layout.gap), LIMITS.width.min, LIMITS.width.max);
	return { width, height: autoHeightFor(width) };
}

/** Absolute ceiling for the splash block, whatever the terminal reports. */
export const BANNER_MAX_WIDTH = 108;
/** Width at which the lower block splits into two panels. */
export const BANNER_MIN_STACK_WIDTH = 76;
/** Width below which the splash degrades to three plain lines. */
export const BANNER_MIN_COMPACT_WIDTH = 32;

/** `#rgb` / `#rrggbb` -> lowercase `#rrggbb`; anything else -> undefined. */
export function parseHexColor(raw: string | undefined): string | undefined {
	if (raw === undefined) return undefined;
	const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw.trim());
	if (!match) return undefined;
	const digits = match[1]!;
	const full =
		digits.length === 3
			? digits
					.split("")
					.map((digit) => digit + digit)
					.join("")
			: digits;
	return `#${full.toLowerCase()}`;
}

/** "44x22" -> {44,22}. Accepts "44X22" and stray whitespace; invalid -> fallback. */
export function parseSize(raw: string | undefined, fallback: BannerSize = { width: 44, height: 22 }): BannerSize {
	if (!raw) return { ...fallback };
	const match = /^\s*(\d+)\s*[xX*]\s*(\d+)\s*$/.exec(raw);
	if (!match) return { ...fallback };
	return {
		width: clamp(Number(match[1]), LIMITS.width.min, LIMITS.width.max),
		height: clamp(Number(match[2]), LIMITS.height.min, LIMITS.height.max),
	};
}
