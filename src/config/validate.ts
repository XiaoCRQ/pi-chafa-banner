/**
 * Defensive parsing of `pi-chafa-banner.json`.
 *
 * Policy (see AGENTS.md): a missing file, a missing key or a typo must never
 * break the splash — the field is dropped, the default is used, and the reason
 * is reported once through `warnings`. Unknown keys are ignored silently so a
 * newer config can be shared with an older checkout.
 */

import { MAX_CHAFA_ARGS_LENGTH } from "../pipeline/args.ts";
import {
	DEFAULT_FILE,
	LIMITS,
	PANEL_FIELDS,
	RESOURCE_SECTIONS,
	clamp,
	type AutoSize,
	type ImageSettings,
	type LayoutSettings,
	type PanelField,
	type PanelsSettings,
	type ResourceSectionId,
} from "./schema.ts";

type Json = Record<string, unknown>;

export interface ValidatedSettings {
	image: ImageSettings;
	layout: LayoutSettings;
	panels: PanelsSettings;
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
 * Tracks the JSON path so warnings read `panels.resources.width: …` instead of
 * a bare key, and shares one warning sink across the whole document.
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

	autoSize(key: string, range: { min: number; max: number }, fallback: AutoSize): AutoSize {
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

	/** String array filtered to `allowed`; duplicates collapse, order is kept. */
	list<T extends string>(key: string, allowed: readonly T[], fallback: readonly T[]): T[] {
		const raw = this.raw[key];
		if (raw === undefined) return [...fallback];
		if (!Array.isArray(raw)) {
			this.warn(key, `expected an array of ${allowed.join(", ")}, got ${show(raw)}`);
			return [...fallback];
		}
		const kept: T[] = [];
		for (const entry of raw) {
			if (typeof entry !== "string" || !allowed.includes(entry as T)) {
				this.warn(key, `ignored unknown entry ${show(entry)}`);
				continue;
			}
			if (!kept.includes(entry as T)) kept.push(entry as T);
		}
		return kept;
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
 * for that single field.
 */
export function validateSettings(raw: unknown): ValidatedSettings {
	const warnings: string[] = [];
	if (raw !== undefined && !isObject(raw)) {
		new Reader({}, "", warnings).warn("root", "expected an object, using defaults");
	}
	const file = new Reader(isObject(raw) ? raw : {}, "", warnings);

	const version = file.raw.version;
	if (version !== undefined && version !== DEFAULTS.version) {
		file.warn("version", `expected ${DEFAULTS.version}, got ${show(version)} (reading anyway)`);
	}

	const image = file.child("image");
	const layout = file.child("layout");
	const panels = file.child("panels");
	const info = panels.child("info");
	const resources = panels.child("resources");
	const behavior = file.child("behavior");

	const imageDefaults = DEFAULTS.image;
	const layoutDefaults = DEFAULTS.layout;
	const panelDefaults = DEFAULTS.panels;
	const behaviorDefaults = DEFAULTS.behavior;

	return {
		image: {
			path: image.text("path"),
			fps: image.rate("fps", LIMITS.fps, imageDefaults.fps),
			stride: image.number("stride", LIMITS.stride, imageDefaults.stride),
			chafa: image.string("chafa", imageDefaults.chafa),
		},
		layout: {
			width: layout.number("width", LIMITS.layoutWidth, layoutDefaults.width),
			gap: layout.number("gap", LIMITS.gap, layoutDefaults.gap),
			twoColumnMinWidth: layout.number("twoColumnMinWidth", LIMITS.layoutWidth, layoutDefaults.twoColumnMinWidth),
			compactMinWidth: layout.number("compactMinWidth", LIMITS.layoutWidth, layoutDefaults.compactMinWidth),
			maxWidth: layout.number("maxWidth", LIMITS.layoutWidth, layoutDefaults.maxWidth),
			lowerRows: layout.number("lowerRows", LIMITS.lowerRows, layoutDefaults.lowerRows),
		},
		panels: {
			info: {
				enabled: info.bool("enabled", panelDefaults.info.enabled),
				fields: info.list("fields", PANEL_FIELDS, [...panelDefaults.info.fields] as PanelField[]),
			},
			resources: {
				enabled: resources.bool("enabled", panelDefaults.resources.enabled),
				sections: resources.list(
					"sections",
					RESOURCE_SECTIONS,
					[...panelDefaults.resources.sections] as ResourceSectionId[],
				),
				width: resources.autoSize("width", LIMITS.panelWidth, "auto"),
				height: resources.autoSize("height", LIMITS.height, "auto"),
				maxLinesPerSection: resources.number(
					"maxLinesPerSection",
					LIMITS.maxLinesPerSection,
					panelDefaults.resources.maxLinesPerSection,
				),
			},
		},
		enabled: behavior.bool("enabled", behaviorDefaults.enabled),
		static: behavior.bool("static", behaviorDefaults.static),
		hideResources: behavior.bool("hidePiResourceList", behaviorDefaults.hidePiResourceList),
		warnings,
	};
}
