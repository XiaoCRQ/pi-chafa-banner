/**
 * Shapes, defaults and hard limits for `pi-chafa-banner.json`.
 *
 * Everything the user can tune lives in the JSON file next to the package (see
 * `load.ts`); this module owns the *shape* of those knobs so validation, tests
 * and docs can share one description. No I/O here.
 */

export interface BannerSize {
	width: number;
	height: number;
}

/** Which facts the info card may show. */
export type PanelField = "version" | "model" | "theme" | "gif" | "frames";

/** Which blocks the RESOURCES panel may show, in file order. */
export type ResourceSectionId = "context" | "skills" | "themes" | "extensions";

export type AutoSize = number | "auto";

/** `"auto"` = the gif's own timing, a number = fixed frames per second. */
export type RateSetting = number | "auto";

export interface ImageSettings {
	path: string | undefined;
	/** Character columns for the picture band. */
	width: number;
	/** Character rows, or `auto` = derive from the source aspect ratio. */
	height: AutoSize;
	fps: RateSetting;
	stride: number;
	/** Extra chafa arguments, exactly as the user typed them. */
	chafa: string;
}

export interface LayoutSettings {
	/** Overall splash width in cells (picture band and both columns). */
	width: number;
	/** Blank columns between the two lower panels. */
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
	version: 1;
	gifPath: string | undefined;
	size: BannerSize;
	/** `true` when `size.height` came from `image.height: "auto"`. */
	heightAuto: boolean;
	fps: RateSetting;
	stride: number;
	/** Parsed `image.chafa` argv, ready to append to the pipeline's own flags. */
	chafaArgs: string[];
	static: boolean;
	enabled: boolean;
	/** Detach pi's own `[Context]/[Skills]/…` listing below the splash. */
	hideResources: boolean;
	layout: LayoutSettings;
	panels: PanelsSettings;
	/** Where the values came from; surfaced by `/splash status`. */
	source: ConfigSource;
}

export interface ConfigSource {
	/** Absolute path of the JSON file that was read, if any. */
	path?: string;
	/** Field-level problems, already de-duplicated. */
	warnings: string[];
}

/** Defaults as they appear in the JSON file. `null` path = "not configured". */
export const DEFAULT_FILE = {
	version: 1,
	image: {
		path: "~/Pictures/logo/v-3.gif",
		width: 44,
		height: "auto",
		fps: "auto",
		stride: 3,
		chafa: "",
	},
	layout: { width: 88, gap: 4, twoColumnMinWidth: 76, compactMinWidth: 32, maxWidth: 108, lowerRows: 12 },
	panels: {
		info: { enabled: true, fields: ["version", "model", "theme"] },
		resources: {
			enabled: true,
			sections: ["context", "skills", "themes", "extensions"],
			width: "auto",
			height: "auto",
			maxLinesPerSection: 6,
		},
	},
	behavior: { enabled: true, static: false, hidePiResourceList: true },
} as const;

/** Hard caps keep a typo from producing an unusable splash. */
export const LIMITS = {
	fps: { min: 1, max: 30 },
	stride: { min: 1, max: 10 },
	width: { min: 8, max: 160 },
	height: { min: 4, max: 60 },
	layoutWidth: { min: 24, max: 200 },
	gap: { min: 0, max: 12 },
	lowerRows: { min: 4, max: 40 },
	maxLinesPerSection: { min: 1, max: 40 },
	panelWidth: { min: 16, max: 200 },
} as const;

export const PANEL_FIELDS: readonly PanelField[] = ["version", "model", "theme", "gif", "frames"];
export const RESOURCE_SECTIONS: readonly ResourceSectionId[] = ["context", "skills", "themes", "extensions"];

export function clamp(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.min(max, Math.max(min, Math.round(value)));
}

export function formatSize(size: BannerSize): string {
	return `${size.width}x${size.height}`;
}

/** Absolute ceiling for the splash block, whatever the terminal reports. */
export const BANNER_MAX_WIDTH = 108;
/** Width at which the lower block splits into two panels. */
export const BANNER_MIN_STACK_WIDTH = 76;
/** Width below which the splash degrades to three plain lines. */
export const BANNER_MIN_COMPACT_WIDTH = 32;

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
