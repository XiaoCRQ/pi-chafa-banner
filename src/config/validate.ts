/**
 * Defensive parsing of `pi-chafa-banner.json` (v2).
 *
 * Policy (see AGENTS.md): a missing file, a missing key or a typo must never
 * break the splash — the field is dropped, the default is used, and the reason
 * is reported once through `warnings`. Unknown keys are ignored silently so a
 * newer config can be shared with an older checkout.
 *
 * One exception, on purpose: a structurally broken `layout` tree is *not*
 * replaced by the default tree. The error is returned as `layoutError` so the
 * renderer can show a `LAYOUT ERROR` card — silently drawing a different splash
 * is exactly what the layout rewrite is meant to stop.
 */

import { MAX_CHAFA_ARGS_LENGTH } from "../pipeline/args.ts";
import type { LayoutNode, SplashGap, SplashSettings } from "../layout/tree.ts";
import { translateLegacyConfig } from "./legacy.ts";
import { hasLayoutTree, parseLayoutTree } from "./tree.ts";
import {
	DEFAULT_FILE,
	LIMITS,
	THEME_PRESETS,
	clamp,
	parseHexColor,
	type ImageSettings,
	type ThemePreset,
	type ThemeSettings,
} from "./schema.ts";

type Json = Record<string, unknown>;

export interface ValidatedSettings {
	image: ImageSettings;
	/** Root box semantics: `width`/`height`/`gap` + the variable-size flags. */
	splash: SplashSettings;
	/** Parsed tree; undefined exactly when `layoutError` is set. */
	layoutTree: LayoutNode | undefined;
	layoutError: string | undefined;
	theme: ThemeSettings;
	enabled: boolean;
	static: boolean;
	hideResources: boolean;
	warnings: string[];
}

const isObject = (value: unknown): value is Json =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const show = (value: unknown): string => {
	if (typeof value === "string") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.length} items]`;
	if (value === null) return "null";
	return String(value);
};

const DEFAULTS = DEFAULT_FILE;

/**
 * Tracks the JSON path so warnings read `image.chafa: …` instead of a bare key,
 * and shares one warning sink across the whole document.
 */
class Reader {
	constructor(
		readonly raw: Json,
		readonly path: string,
		readonly warnings: string[],
	) {}

	/** One level down; a non-object group is reported and treated as empty. */
	child(key: string): Reader {
		const path = this.path ? `${this.path}.${key}` : key;
		const raw = this.raw[key];
		if (raw === undefined) return new Reader({}, path, this.warnings);
		if (!isObject(raw)) {
			this.warn(key, "expected an object");
			return new Reader({}, path, this.warnings);
		}
		return new Reader(raw, path, this.warnings);
	}

	warn(key: string, problem: string): void {
		this.warnings.push(`${this.path ? `${this.path}.` : ""}${key}: ${problem}`);
	}

	number(key: string, range: { min: number; max: number }, fallback: number): number {
		const raw = this.raw[key];
		if (raw === undefined) return fallback;
		if (typeof raw !== "number" || !Number.isFinite(raw)) {
			this.warn(key, `expected a number between ${range.min} and ${range.max}, got ${show(raw)}`);
			return fallback;
		}
		const clamped = clamp(raw, range.min, range.max);
		if (clamped !== Math.round(raw)) this.warn(key, `clamped to ${clamped}`);
		return clamped;
	}

	/** `"auto"` or a number clamped to `range`; anything else falls back. */
	rate(key: string, range: { min: number; max: number }, fallback: number | "auto"): number | "auto" {
		const raw = this.raw[key];
		if (raw === undefined) return fallback;
		if (raw === "auto") return "auto";
		if (typeof raw !== "number" || !Number.isFinite(raw)) {
			this.warn(key, `expected "auto" or a number between ${range.min} and ${range.max}, got ${show(raw)}`);
			return fallback;
		}
		const clamped = clamp(raw, range.min, range.max);
		if (clamped !== Math.round(raw)) this.warn(key, `clamped to ${clamped}`);
		return clamped;
	}

	/**
	 * Gap per axis: a number (both axes), or `{ width, height }`. Each axis is
	 * clamped on its own; a malformed axis keeps its fallback and warns.
	 */
	gap(key: string, range: { min: number; max: number }, fallback: SplashGap): SplashGap {
		const raw = this.raw[key];
		if (raw === undefined) return fallback;
		if (typeof raw === "number") {
			const both = this.number(key, range, fallback.width);
			return { width: both, height: both };
		}
		if (!isObject(raw)) {
			this.warn(key, `expected a number or { width, height }, got ${show(raw)}`);
			return fallback;
		}
		const nested = new Reader(raw, this.path ? `${this.path}.${key}` : key, this.warnings);
		return {
			width: nested.number("width", range, fallback.width),
			height: nested.number("height", range, fallback.height),
		};
	}

	/** `"auto"` (content-driven) or a number clamped to `range`; anything else falls back. */
	height(key: string, range: { min: number; max: number }, fallback: number | null): number | null {
		const raw = this.raw[key];
		if (raw === undefined) return fallback;
		if (raw === "auto") return null;
		if (typeof raw !== "number" || !Number.isFinite(raw)) {
			this.warn(key, `expected "auto" or a number between ${range.min} and ${range.max}, got ${show(raw)}`);
			return fallback;
		}
		const clamped = clamp(raw, range.min, range.max);
		if (clamped !== Math.round(raw)) this.warn(key, `clamped to ${clamped}`);
		return clamped;
	}

	bool(key: string, fallback: boolean): boolean {
		const raw = this.raw[key];
		if (raw === undefined) return fallback;
		if (typeof raw !== "boolean") {
			this.warn(key, `expected true or false, got ${show(raw)}`);
			return fallback;
		}
		return raw;
	}

	oneOf<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
		const raw = this.raw[key];
		if (raw === undefined) return fallback;
		if (typeof raw !== "string" || !allowed.includes(raw as T)) {
			this.warn(key, `expected one of ${allowed.join(", ")}, got ${show(raw)}`);
			return fallback;
		}
		return raw as T;
	}

	/** Free-form string (chafa arguments); a wrong type falls back to `fallback`. */
	string(key: string, fallback: string): string {
		const raw = this.raw[key];
		if (raw === undefined) return fallback;
		if (typeof raw !== "string") {
			this.warn(key, `expected a string, got ${show(raw)}`);
			return fallback;
		}
		if (raw.length > MAX_CHAFA_ARGS_LENGTH) {
			this.warn(key, `truncated to ${MAX_CHAFA_ARGS_LENGTH} characters`);
			return raw.slice(0, MAX_CHAFA_ARGS_LENGTH);
		}
		return raw;
	}

	/**
	 * `#rgb` / `#rrggbb`; blank means "use the preset" and is not warned about.
	 * A malformed value is dropped with a warning rather than failing the load.
	 */
	color(key: string): string | undefined {
		const raw = this.raw[key];
		if (raw === undefined) return undefined;
		if (typeof raw !== "string") {
			this.warn(key, `expected a "#rrggbb" colour, got ${show(raw)}`);
			return undefined;
		}
		if (raw.trim() === "") return undefined;
		const hex = parseHexColor(raw);
		if (!hex) {
			this.warn(key, `expected a "#rgb" or "#rrggbb" colour, got ${show(raw)}`);
			return undefined;
		}
		return hex;
	}

	/** Optional path string; blank strings count as "not set". */
	text(key: string): string | undefined {
		const raw = this.raw[key];
		if (raw === undefined) return undefined;
		if (typeof raw !== "string" || raw.trim() === "") {
			this.warn(key, `expected a non-empty path, got ${show(raw)}`);
			return undefined;
		}
		return raw.trim();
	}
}

/**
 * Turn whatever `JSON.parse` produced into usable settings.
 *
 * Never throws: every problem lands in `warnings` and falls back to the default
 * for that single field — except a structural layout error, which is reported
 * through `layoutError` with `layoutTree` left undefined.
 */
export function validateSettings(raw: unknown): ValidatedSettings {
	const warnings: string[] = [];
	if (raw !== undefined && !isObject(raw)) {
		new Reader({}, "", warnings).warn("root", "expected an object, using defaults");
	}
	const file = new Reader(isObject(raw) ? raw : {}, "", warnings);

	const image = file.child("image");
	const theme = file.child("theme");
	const behavior = file.child("behavior");

	const imageDefaults = DEFAULTS.image;
	const behaviorDefaults = DEFAULTS.behavior;

	// v2 detection is structural: `layout.type` or `layout.children` means a tree.
	// A v1 flat group is translated; anything else (null, array, string) is a
	// structural error the parser reports.
	const rawLayout = file.raw.layout;
	const version = file.raw.version;
	let layoutTree: LayoutNode | undefined;
	let layoutError: string | undefined;
	let legacyWidth: number | undefined;
	let legacyGap: number | undefined;
	let legacyCompactWidth: number | undefined;

	// One version check for every shape of file: a tree, a v1 flat group or a
	// bare `{width, height}` document. It never changes what is read, and a v1
	// flat group is a supported shape rather than a mismatch.
	const treeShape = rawLayout !== undefined && isObject(rawLayout) && hasLayoutTree(rawLayout);
	if (version !== undefined) {
		if (version !== 1 && version !== DEFAULTS.version) {
			const expected = treeShape ? `${DEFAULTS.version}` : `1 or ${DEFAULTS.version}`;
			file.warn("version", `expected ${expected}, got ${show(version)} (reading anyway)`);
		} else if (treeShape && version !== DEFAULTS.version) {
			file.warn("version", `expected ${DEFAULTS.version}, got ${show(version)} (reading anyway)`);
		}
	}

	if (rawLayout !== undefined && (!isObject(rawLayout) || hasLayoutTree(rawLayout))) {
		const parsed = parseLayoutTree(rawLayout, "layout");
		layoutTree = parsed.tree;
		layoutError = parsed.error;
		warnings.push(...parsed.warnings);
		// The renderer shows the card; `warnings` is what `/splash status` and a
		// failed `/splash reload` print, so the reason has to travel with them.
		if (layoutError !== undefined) warnings.push(`layout: ${layoutError}`);
	} else {
		const legacy = translateLegacyConfig(file.raw);
		warnings.push(...legacy.warnings);
		layoutTree = legacy.tree;
		legacyWidth = legacy.width;
		legacyGap = legacy.gap;
		legacyCompactWidth = legacy.compactWidth;
	}

	const splash: SplashSettings = {
		width: file.number("width", LIMITS.width, legacyWidth ?? DEFAULTS.width),
		height: file.height("height", LIMITS.height, DEFAULTS.height),
		gap: file.gap("gap", LIMITS.gap, legacyGap === undefined ? DEFAULTS.gap : { width: legacyGap, height: 0 }),
		variableWidth: file.bool("variableWidth", DEFAULTS.variableWidth),
		variableHeight: file.bool("variableHeight", DEFAULTS.variableHeight),
		compactWidth: file.number("compactWidth", LIMITS.compactWidth, legacyCompactWidth ?? DEFAULTS.compactWidth),
	};

	return {
		image: {
			path: image.text("path"),
			fps: image.rate("fps", LIMITS.fps, imageDefaults.fps),
			stride: image.number("stride", LIMITS.stride, imageDefaults.stride),
			chafa: image.string("chafa", imageDefaults.chafa),
		},
		splash,
		layoutTree,
		layoutError,
		theme: {
			preset: theme.oneOf("preset", THEME_PRESETS, DEFAULTS.theme.preset as ThemePreset),
			windowTitle: theme.color("windowTitle"),
			sectionTitle: theme.color("sectionTitle"),
			border: theme.color("border"),
			content: theme.color("content"),
		},
		enabled: behavior.bool("enabled", behaviorDefaults.enabled),
		static: behavior.bool("static", behaviorDefaults.static),
		hideResources: behavior.bool("hidePiResourceList", behaviorDefaults.hidePiResourceList),
		warnings,
	};
}
