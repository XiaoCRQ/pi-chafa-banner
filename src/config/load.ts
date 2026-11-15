/**
 * Reads `<plugin-root>/pi-chafa-banner.json` and turns it into a `BannerConfig`.
 *
 * The file lives next to this package, not in the user's home: a global install
 * (`~/.pi/agent/`) reads `~/.pi/agent/pi-chafa-banner.json`, a project install
 * (`<repo>/.pi/`) reads `<repo>/.pi/pi-chafa-banner.json`. There is no
 * cross-directory merge — whichever copy of the extension is loaded owns its
 * config, which keeps `/splash status` unambiguous.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseChafaArgs } from "../pipeline/args.ts";
import {
	DEFAULT_FILE,
	LIMITS,
	clamp,
	derivedCanvas,
	formatSize,
	type BannerConfig,
	type BannerSize,
	type ConfigSource,
	type LayoutSettings,
	type PanelsSettings,
} from "./schema.ts";
import { validateSettings } from "./validate.ts";

export function expandHome(input: string): string {
	if (input === "~") return homedir();
	if (input.startsWith("~/")) return join(homedir(), input.slice(2));
	return input;
}

/** pi's config dir, honouring the documented override. */
export function piAgentDir(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.PI_CODING_AGENT_DIR;
	return override && override.trim() ? expandHome(override.trim()) : join(homedir(), ".pi", "agent");
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * Root of the installed package: the nearest directory holding a
 * `package.json`, starting from this module. Works for `pi -e <repo>`, a global
 * `~/.pi/agent/npm/node_modules/pi-chafa-banner` install and a bundled copy
 * alike — no `process.cwd()` involved, because pi can be started anywhere.
 */
export function pluginRoot(start: string = MODULE_DIR): string {
	let dir = start;
	for (let depth = 0; depth < 8; depth++) {
		if (existsSync(join(dir, "package.json"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return start;
}

/** `<plugin-root>/pi-chafa-banner.json` — the only config file we read. */
export function configPath(root: string = pluginRoot()): string {
	return join(root, "pi-chafa-banner.json");
}

/** Gif shipped with the package; the out-of-the-box fallback artwork. */
export function bundledGifPath(root: string = pluginRoot()): string {
	return join(root, "assets", "banner.gif");
}

export interface LoadOptions {
	/** Override the package root (tests, `--config` in the preview). */
	root?: string;
	/** Override the file read (tests). Return `undefined` for "no file". */
	read?: (path: string) => string | undefined;
}

export interface LoadResult {
	config: BannerConfig;
	/** Absolute path that was read, or undefined when defaults were used. */
	path?: string;
}

const readIfPresent = (path: string): string | undefined => {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES") return undefined;
		throw error;
	}
};

/**
 * Resolve the artwork: an explicit `image.path` always wins (even when missing —
 * a clear "cannot read" beats silently animating a different picture), then the
 * `~/Pictures/logo/v-3.gif` default, then the bundled asset.
 */
function resolveGifPath(configured: string | undefined, root: string): string | undefined {
	if (configured) {
		const expanded = expandHome(configured);
		return isAbsolute(expanded) ? expanded : resolve(root, expanded);
	}
	const preferred = join(homedir(), "Pictures", "logo", "v-3.gif");
	if (existsSync(preferred)) return preferred;
	const legacy = join(homedir(), "Pictures", "logo", "v-1.gif");
	if (existsSync(legacy)) return legacy;
	return bundledGifPath(root);
}

/**
 * Refine the canvas height once the actual artwork dimensions are known.
 *
 * Terminal cells are ~9x18 px, so a `srcH/srcW` aspect ratio becomes
 * `width * aspect * 0.5` character rows. Called from the build path, right
 * before frames are rendered; the pipeline needs a fixed grid for its cache key.
 */
export function applySourceSize(config: BannerConfig, source: { width: number; height: number }): BannerConfig {
	if (!(source.width > 0) || !(source.height > 0)) return config;
	const height = clamp(
		Math.round((config.size.width * source.height) / source.width / 2),
		LIMITS.height.min,
		LIMITS.height.max,
	);
	if (height === config.size.height) return config;
	return { ...config, size: { ...config.size, height } };
}

/**
 * Load the config file. Never throws: a missing file yields defaults, a broken
 * file yields defaults plus one warning, and bad individual fields are dropped.
 */
export function loadConfig(options: LoadOptions = {}): BannerConfig {
	const root = options.root ?? pluginRoot();
	const path = configPath(root);
	const read = options.read ?? readIfPresent;
	const warnings: string[] = [];
	let parsed: unknown;

	let text: string | undefined;
	try {
		text = read(path);
	} catch (error) {
		warnings.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (text !== undefined) {
		try {
			parsed = JSON.parse(text);
		} catch (error) {
			warnings.push(`${path}: invalid JSON (${error instanceof Error ? error.message : String(error)})`);
		}
	}

	const settings = validateSettings(parsed);
	warnings.push(...settings.warnings);
	const source: ConfigSource = { path: text !== undefined ? path : undefined, warnings };

	// The canvas is derived, not configured: two equal columns, so the artwork is
	// exactly one column wide and the height follows the gif's aspect ratio.
	const layout: LayoutSettings = settings.layout;
	const size: BannerSize = derivedCanvas(layout);
	const panels: PanelsSettings = settings.panels;

	return {
		version: 1,
		gifPath: resolveGifPath(settings.image.path, root),
		size,
		fps: settings.image.fps,
		stride: settings.image.stride,
		chafaArgs: parseChafaArgs(settings.image.chafa),
		static: settings.static,
		enabled: settings.enabled,
		hideResources: settings.hideResources,
		layout,
		panels,
		source,
	};
}

/**
 * Test seam: the extension entry point has no way to receive a `LoadOptions`
 * (pi constructs it), so integration tests swap the loader instead of writing a
 * real `pi-chafa-banner.json` into the package.
 */
let configLoader: (() => BannerConfig) | undefined;

export function setConfigLoader(loader: (() => BannerConfig) | undefined): void {
	configLoader = loader;
}

/** `loadConfig()` through the optional test seam. */
export function loadSessionConfig(): BannerConfig {
	return configLoader ? configLoader() : loadConfig();
}

/** `configPath` of the file this config was loaded from, for status output. */
export function describeConfigSource(config: BannerConfig): string {
	return config.source.path ?? "built-in defaults (no pi-chafa-banner.json)";
}

/** One-line summary used by `/splash status`. */
export function describeConfig(config: BannerConfig): string {
	return [
		`gif=${config.gifPath ?? "(none)"}`,
		`image=${formatSize(config.size)} (derived)`,
		`gap=${config.layout.gap}`,
		`layout=${config.layout.width}`,
		`fps=${config.fps === "auto" ? "native" : config.fps}`,
		`stride=${config.stride}`,
		`static=${config.static}`,
		config.chafaArgs.length > 0 ? `chafa="${config.chafaArgs.join(" ")}"` : undefined,
	]
		.filter((part): part is string => part !== undefined)
		.join("  ");
}

export { DEFAULT_FILE };

/** Root of the installed package (resolved once; see `pluginRoot`). */
export const PACKAGE_ROOT = pluginRoot(MODULE_DIR);
/** Gif shipped with the package. */
export const BUNDLED_GIF_PATH = bundledGifPath(PACKAGE_ROOT);

/**
 * Fully-resolved defaults (`pi-chafa-banner.json` absent or unreadable).
 *
 * Exported as a whole object because tests and the preview script spread it to
 * build variants; it is intentionally the same shape `loadConfig()` returns.
 */
export const DEFAULTS: BannerConfig = {
	version: 1,
	gifPath: BUNDLED_GIF_PATH,
	size: derivedCanvas(DEFAULT_FILE.layout),
	fps: DEFAULT_FILE.image.fps,
	stride: DEFAULT_FILE.image.stride,
	chafaArgs: parseChafaArgs(DEFAULT_FILE.image.chafa),
	static: DEFAULT_FILE.behavior.static,
	enabled: DEFAULT_FILE.behavior.enabled,
	hideResources: DEFAULT_FILE.behavior.hidePiResourceList,
	layout: { ...DEFAULT_FILE.layout },
	panels: {
		info: { ...DEFAULT_FILE.panels.info, fields: [...DEFAULT_FILE.panels.info.fields] },
		resources: { ...DEFAULT_FILE.panels.resources, sections: [...DEFAULT_FILE.panels.resources.sections] },
	},
	source: { warnings: [] },
};
