/**
 * Configuration surface: every knob is an environment variable so the splash
 * can be tuned per-shell without touching pi's settings (extensions must not
 * write the user's settings.json).
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url"

export interface BannerSize {
	width: number;
	height: number;
}

export type BannerRenderer = "auto" | "chars" | "kitty";

export interface BannerConfig {
	gifPath: string | undefined;
	size: BannerSize;
	fps: number;
	stride: number;
	renderer: BannerRenderer;
	static: boolean;
	enabled: boolean;
}

export const DEFAULTS = {
	fps: 16,
	stride: 3,
	size: { width: 44, height: 22 } satisfies BannerSize,
	renderer: "auto" as BannerRenderer,
} as const;

/** Hard caps keep a mis-set env var from producing an unusable splash. */
export const LIMITS = {
	fps: { min: 1, max: 30 },
	stride: { min: 1, max: 10 },
	width: { min: 8, max: 160 },
	height: { min: 4, max: 60 },
} as const;

export const BANNER_MAX_WIDTH = 108;
export const BANNER_MIN_STACK_WIDTH = 76;
export const BANNER_MIN_COMPACT_WIDTH = 32;

export function clamp(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.min(max, Math.max(min, Math.round(value)));
}

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

/** "44x22" -> {44,22}. Accepts "44X22" and stray whitespace; invalid input -> fallback. */
export function parseSize(raw: string | undefined, fallback: BannerSize = DEFAULTS.size): BannerSize {
	if (!raw) return { ...fallback };
	const match = /^\s*(\d+)\s*[xX*]\s*(\d+)\s*$/.exec(raw);
	if (!match) return { ...fallback };
	return {
		width: clamp(Number(match[1]), LIMITS.width.min, LIMITS.width.max),
		height: clamp(Number(match[2]), LIMITS.height.min, LIMITS.height.max),
	};
}

export function parseBool(raw: string | undefined): boolean {
	if (!raw) return false;
	return /^(1|true|yes|on)$/i.test(raw.trim());
}

export function parseRenderer(raw: string | undefined): BannerRenderer {
	const value = (raw ?? "").trim().toLowerCase();
	return value === "chars" || value === "kitty" || value === "auto" ? value : DEFAULTS.renderer;
}

export function formatSize(size: BannerSize): string {
	return `${size.width}x${size.height}`;
}

// Asset paths are resolved relative to this module, not process.cwd(): pi may
// be started from anywhere, and `pi -e <repo>` / a global install must still
// find the bundled art.
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
export const PACKAGE_ROOT = dirname(MODULE_DIR);
/** Gif shipped with the package; the out-of-the-box default artwork. */
export const BUNDLED_GIF_PATH = join(PACKAGE_ROOT, "assets", "banner.gif");

/**
 * Resolve the gif to animate. Order: explicit env, the gif bundled with this
 * package, a per-user drop-in at ~/.pi/agent/banner.gif, then the original
 * ~/Pictures/logo/v-1.gif the bundle was copied from (keeps old checkouts
 * working). Returning undefined lets the caller degrade to the builtin header
 * with a notice.
 */
export function defaultGifPath(
	env: NodeJS.ProcessEnv = process.env,
	bundled: string = BUNDLED_GIF_PATH,
): string | undefined {
	// An explicit setting always wins, even if the file is missing: silently
	// animating a different gif than the user asked for is worse than a clear
	// "cannot read <path>" diagnostic from frames.ts.
	const explicit = env.PI_BANNER_GIF?.trim();
	if (explicit) {
		const expanded = expandHome(explicit);
		return isAbsolute(expanded) ? expanded : join(process.cwd(), expanded);
	}
	if (existsSync(bundled)) return bundled;
	const candidates = [join(piAgentDir(env), "banner.gif"), join(homedir(), "Pictures", "logo", "v-1.gif")];
	for (const candidate of candidates) if (existsSync(candidate)) return candidate;
	// Nothing on disk: return the bundled location so status output is helpful.
	return bundled;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): BannerConfig {
	const size = parseSize(env.PI_BANNER_SIZE, DEFAULTS.size);
	const fpsRaw = env.PI_BANNER_FPS ? Number(env.PI_BANNER_FPS) : DEFAULTS.fps;
	const strideRaw = env.PI_BANNER_STRIDE ? Number(env.PI_BANNER_STRIDE) : DEFAULTS.stride;
	return {
		gifPath: defaultGifPath(env),
		size,
		fps: clamp(fpsRaw, LIMITS.fps.min, LIMITS.fps.max),
		stride: clamp(strideRaw, LIMITS.stride.min, LIMITS.stride.max),
		renderer: parseRenderer(env.PI_BANNER_RENDERER),
		static: parseBool(env.PI_BANNER_STATIC),
		enabled: !parseBool(env.PI_BANNER_DISABLED),
	};
}

/** One-line summary used by `/splash status`. */
export function describeConfig(config: BannerConfig): string {
	return [
		`gif=${config.gifPath ?? "(none)"}`,
		`size=${formatSize(config.size)}`,
		`fps=${config.fps}`,
		`stride=${config.stride}`,
		`renderer=${config.renderer}`,
		`static=${config.static}`,
	].join("  ");
}
