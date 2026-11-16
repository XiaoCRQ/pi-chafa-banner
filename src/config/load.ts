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
import { NODE_MIN, planChafaNodes, plansForWidth, type ChafaPlan, type LayoutNode, type SplashSettings } from "../layout/tree.ts";
import {
	BANNER_MAX_WIDTH,
	BANNER_MIN_STACK_WIDTH,
	DEFAULT_FILE,
	LIMITS,
	PANEL_FIELDS,
	RESOURCE_SECTIONS,
	clamp,
	derivedCanvas,
	formatSize,
	type BannerConfig,
	type BannerSize,
	type ConfigSource,
	type LayoutSettings,
	type PanelField,
	type PanelsSettings,
	type ResourceSectionId,
} from "./schema.ts";
import { validateSettings, type ValidatedSettings } from "./validate.ts";

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
 * Refine every planned canvas once the actual artwork dimensions are known.
 *
 * Terminal cells are ~9x18 px, so a `srcH/srcW` aspect ratio becomes
 * `width * aspect * 0.5` character rows. Pure data in, new array out: the
 * pipeline needs a fixed grid for its cache key, so the plan is rebuilt before
 * frames are rendered and never touched afterwards.
 */
export function applyPlanAspect(plans: readonly ChafaPlan[], source: { width: number; height: number }): ChafaPlan[] {
	if (!(source.width > 0) || !(source.height > 0)) return [...plans];
	return plans.map((plan) => {
		const height = planHeightFor(plan, source);
		return height === plan.height ? plan : { ...plan, height };
	});
}

/**
 * Re-solve every canvas for a box the terminal can actually show.
 *
 * The configured `width` stays the width the user asked for; only the plans (and
 * with them the frame cache key) move. Heights keep whatever aspect ratio the
 * session already probed, so a narrower box scales the artwork down instead of
 * cropping it. Returns the same config object when nothing changes.
 */
export function applyPlanWidth(config: BannerConfig, width: number): BannerConfig {
	const tree = config.layoutTree;
	if (!tree || config.plans.length === 0) return config;
	const target = clamp(Math.floor(width), LIMITS.width.min, LIMITS.width.max);
	if (config.planWidth === target) return config;
	const plans = plansForWidth(tree, config.splash, target, config.plans, config.gifPath, config.chafaArgs);
	const first = plans[0];
	if (!first) return config;
	return { ...config, plans, planWidth: target, size: { width: first.width, height: first.height } };
}

function planHeightFor(plan: ChafaPlan, source: { width: number; height: number }): number {
	if (!(source.width > 0) || !(source.height > 0)) return plan.height;
	return clamp(
		Math.round((plan.width * source.height) / source.width / 2),
		NODE_MIN.chafa.height,
		LIMITS.height.max,
	);
}

/**
 * Per-image variant of `applyPlanAspect`: the layout may point several `chafa`
 * nodes at different files, so each plan takes the aspect of its own artwork.
 * Plans whose image could not be probed keep their width-derived height.
 */
export function applyPlanSources(
	config: BannerConfig,
	sources: ReadonlyMap<string, { width: number; height: number }>,
): BannerConfig {
	if (config.plans.length === 0 || sources.size === 0) return config;
	let changed = false;
	const plans = config.plans.map((plan) => {
		const source = sources.get(plan.image);
		if (!source) return plan;
		const height = planHeightFor(plan, source);
		if (height === plan.height) return plan;
		changed = true;
		return { ...plan, height };
	});
	if (!changed) return config;
	const first = plans[0]!;
	return { ...config, plans, size: { width: first.width, height: first.height } };
}

/**
 * `applyPlanAspect` at the config level: the frames pipeline only reads
 * `config.size`, so the first chafa canvas is mirrored back onto it.
 */
export function applySourceSize(config: BannerConfig, source: { width: number; height: number }): BannerConfig {
	if (!(source.width > 0) || !(source.height > 0)) return config;
	if (config.plans.length === 0) {
		// No tree (layout error) — keep the old single-canvas behaviour.
		const height = clamp(
			Math.round((config.size.width * source.height) / source.width / 2),
			LIMITS.height.min,
			LIMITS.height.max,
		);
		return height === config.size.height ? config : { ...config, size: { ...config.size, height } };
	}
	const plans = applyPlanAspect(config.plans, source);
	const first = plans[0]!;
	if (first.width === config.size.width && first.height === config.size.height) {
		return plans.every((plan, index) => plan === config.plans[index]) ? config : { ...config, plans };
	}
	return { ...config, size: { width: first.width, height: first.height }, plans };
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
	const gifPath = resolveGifPath(settings.image.path, root);
	const source: ConfigSource = { path: text !== undefined ? path : undefined, warnings };

	return assemble(settings, gifPath, source);
}

/**
 * Resolve parsed settings into the flat config the renderer consumes.
 *
 * The chafa canvases are solved here, once, from config + weights + gap only —
 * never from the terminal size, so the frames can be pre-rendered and the
 * render loop stays synchronous.
 */
function assemble(settings: ValidatedSettings, gifPath: string | undefined, source?: ConfigSource): BannerConfig {
	const chafaArgs = parseChafaArgs(settings.image.chafa);
	const plans: ChafaPlan[] = settings.layoutTree
		? planChafaNodes(settings.layoutTree, settings.splash, gifPath, chafaArgs)
		: [];
	const layout = mirrorLayout(settings.splash);
	const size: BannerSize = plans[0]
		? { width: plans[0].width, height: plans[0].height }
		: derivedCanvas(layout);

	return {
		version: DEFAULT_FILE.version,
		gifPath,
		size,
		fps: settings.image.fps,
		stride: settings.image.stride,
		chafaArgs,
		static: settings.static,
		enabled: settings.enabled,
		hideResources: settings.hideResources,
		splash: settings.splash,
		layoutTree: settings.layoutTree,
		layoutError: settings.layoutError,
		plans,
		planWidth: settings.splash.width,
		layout,
		panels: mirrorPanels(settings.layoutTree),
		theme: settings.theme,
		source: source ?? { warnings: [] },
	};
}

/**
 * Compatibility mirror for the pre-tree renderer, until it is ported to the
 * layout tree: the flat knobs it still reads, derived from `splash`.
 */
function mirrorLayout(splash: SplashSettings): LayoutSettings {
	return {
		width: splash.width,
		gap: splash.gap.width,
		twoColumnMinWidth: BANNER_MIN_STACK_WIDTH,
		compactMinWidth: splash.compactWidth,
		maxWidth: BANNER_MAX_WIDTH,
		lowerRows: 12,
	};
}

/** Window titled `title`, searched depth-first. */
function findWindow(node: LayoutNode, title: string): Extract<LayoutNode, { type: "window" }> | undefined {
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
 * Compatibility mirror for the pre-tree renderer: which info fields and
 * resource sections the tree actually shows. No tree (layout error) disables
 * both panels so the old path cannot draw a splash next to the error card.
 */
function mirrorPanels(tree: LayoutNode | undefined): PanelsSettings {
	const fields: PanelField[] = [];
	const sections: ResourceSectionId[] = [];
	if (tree) {
		const info = findWindow(tree, "CODING AGENT");
		for (const spec of info?.content ?? []) {
			const field = PANEL_FIELDS.find((candidate) => candidate === spec.content);
			if (field && !fields.includes(field)) fields.push(field);
		}
		const resources = findWindow(tree, "RESOURCES");
		for (const spec of resources?.content ?? []) {
			const section = RESOURCE_SECTIONS.find((candidate) => candidate === spec.content);
			if (section && !sections.includes(section)) sections.push(section);
		}
	}
	return {
		info: { enabled: fields.length > 0, fields },
		resources: {
			enabled: sections.length > 0,
			sections,
			width: "auto",
			height: "auto",
			maxLinesPerSection: 6,
		},
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
	const theme = config.theme;
	const splash = config.splash;
	const overrides = (["windowTitle", "sectionTitle", "border", "content"] as const)
		.filter((role) => theme[role])
		.map((role) => `${role}=${theme[role]}`);
	return [
		`gif=${config.gifPath ?? "(none)"}`,
		`image=${formatSize(config.size)} (derived)`,
		`width=${splash.width}${splash.variableWidth ? "+" : ""}`,
		`height=${splash.height === null ? "auto" : `${splash.height}${splash.variableHeight ? "+" : ""}`}`,
		`gap=${splash.gap.width}/${splash.gap.height}`,
		config.layoutError ? "layout=error" : `nodes=${countNodes(config.layoutTree)}`,
		`fps=${config.fps === "auto" ? "native" : config.fps}`,
		`stride=${config.stride}`,
		`static=${config.static}`,
		`theme=${theme.preset}${overrides.length > 0 ? ` (${overrides.join(", ")})` : ""}`,
		config.chafaArgs.length > 0 ? `chafa="${config.chafaArgs.join(" ")}"` : undefined,
	]
		.filter((part): part is string => part !== undefined)
		.join("  ");
}

/** Nodes in the tree, chafa + layout + window, for `/splash status`. */
function countNodes(tree: LayoutNode | undefined): number {
	if (!tree) return 0;
	return tree.type === "layout" ? 1 + tree.children.reduce((sum, child) => sum + countNodes(child), 0) : 1;
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
export const DEFAULTS: BannerConfig = assemble(validateSettings(undefined), BUNDLED_GIF_PATH);
