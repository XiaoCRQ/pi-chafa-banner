/**
 * Session bootstrap and the background build.
 *
 * `bootstrap()` runs once on `session_start`: install the header, kick off the
 * (slow) chafa build. Everything that can fail is caught and surfaced as a
 * status line — the splash degrades, it never throws.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadPlanFrames, type FrameBundle } from "../frames.ts";
import { applyPlanSources, applyPlanWidth, loadSessionConfig, type BannerConfig } from "../config.ts";
import { probeSourceSize } from "../pipeline/process.ts";
import { collectResources, emptyResources, type BannerResources } from "../resources.ts";
import { installHeader } from "./header.ts";
import { createState, errorText, session, type SessionState } from "./state.ts";

/** pi's own API handle, for the synchronous `getCommands()`/`getSettings()` probes. */
let cachedPi: ExtensionAPI | undefined;

/**
 * Give every planned canvas its real height: a canvas width comes from the
 * config and the weights, the height follows the artwork's aspect ratio. Each
 * image is probed once, so two nodes sharing a gif pay for a single ffprobe.
 */
async function withSourceAspects(config: BannerConfig): Promise<BannerConfig> {
	const images = new Set(config.plans.map((plan) => plan.image).filter(Boolean));
	if (images.size === 0) return config;
	const sources = new Map<string, { width: number; height: number }>();
	for (const image of images) {
		try {
			sources.set(image, await probeSourceSize(image));
		} catch {
			// Keep the width-derived guess; the build reports real failures.
		}
	}
	return applyPlanSources(config, sources);
}

export async function buildContent(
	ctx: ExtensionContext,
	current: SessionState,
	force = false,
	next?: BannerConfig,
): Promise<void> {
	if (current.building) return;
	current.building = true;
	try {
		const config = await withSourceAspects(next ?? current.config);
		const colorMode = current.theme?.getColorMode() ?? "truecolor";
		const bundle: FrameBundle = await loadPlanFrames(config, colorMode, { force });
		// Swap the box and its canvases together: a width change re-keys every
		// frame, so a half-applied config would show placeholders.
		current.config = config;
		current.frames = bundle.frames;
		// A partially failed build still shows the working canvases; the failures
		// land in the status line so the placeholder cards explain themselves.
		current.status = bundle.errors.length > 0 ? bundle.errors.join("; ") : undefined;
		current.banner?.setConfig(config);
		current.banner?.setStatus(current.status);
		current.banner?.setFrames(bundle.frames);
		if (bundle.frames.size === 0 && bundle.errors.length > 0 && !current.notified) {
			current.notified = true;
			ctx.ui.notify(`pi-chafa-banner: ${current.status}`, "warning");
		}
	} catch (error) {
		// A failed build shows the placeholder card rather than an empty header.
		current.frames = undefined;
		current.status = errorText(error);
		current.banner?.setStatus(current.status);
		current.banner?.setFrames(undefined);
		if (!current.notified) {
			current.notified = true;
			ctx.ui.notify(`pi-chafa-banner: ${current.status}`, "warning");
		}
	} finally {
		current.building = false;
		current.tui?.requestRender();
	}
}

async function collectFor(ctx: ExtensionContext, config: BannerConfig): Promise<BannerResources> {
	try {
		return await collectResources({
			cwd: ctx.cwd,
			commands: safeCommands(),
			settings: safeSettings(),
			model: ctx.model,
			thinking: ctx.thinkingLevel,
			ownCommandName: "splash",
		});
	} catch {
		return emptyResources();
	}
}

function safeCommands() {
	try {
		return cachedPi?.getCommands() ?? [];
	} catch {
		return [];
	}
}

function safeSettings() {
	try {
		return cachedPi?.getSettings() ?? {};
	} catch {
		return {};
	}
}

export async function bootstrap(pi: ExtensionAPI, ctx: ExtensionContext): Promise<SessionState> {
	cachedPi = pi;
	const config = loadSessionConfig();
	const resources = await collectFor(ctx, config);
	const current = createState(config, resources);
	current.ctx = ctx;
	session.current = current;

	if (!config.enabled) {
		ctx.ui.notify("pi-chafa-banner: disabled (behavior.enabled is false in pi-chafa-banner.json)", "info");
		return current;
	}

	installHeader(ctx, current);
	current.onWidthRequest = (width) => resizeSplash(ctx, current, width);
	void buildContent(ctx, current);
	return current;
}

/**
 * Re-collect the panel data. `extra` carries values from an event that pi has
 * not committed to `ctx` yet (`model_select`, `thinking_level_select`), so the
 * card updates in the same tick the change happens.
 */
export async function refreshResources(ctx: ExtensionContext, current: SessionState, extra?: {
	contextFiles?: string[];
	skills?: string[];
	model?: ExtensionContext["model"];
	thinking?: string;
}): Promise<void> {
	try {
		const next = await collectResources({
			cwd: ctx.cwd,
			commands: safeCommands(),
			settings: safeSettings(),
			model: extra?.model ?? ctx.model,
			thinking: extra?.thinking ?? ctx.thinkingLevel,
			contextFiles: extra?.contextFiles,
			skills: extra?.skills,
			ownCommandName: "splash",
		});
		if (JSON.stringify(next) === JSON.stringify(current.resources)) return;
		current.resources = next;
		current.banner?.setResources(next);
		current.tui?.requestRender();
	} catch {
		// Resource refresh is cosmetic; ignore.
	}
}

/** Rebuild on demand (`/splash rebuild|reload`). */
export function scheduleRebuild(ctx: ExtensionContext, current: SessionState): void {
	if (current.building) return;
	void buildContent(ctx, current, true);
}

/** How long the terminal gets to settle before canvases are rebuilt. */
const RESIZE_DEBOUNCE_MS = 250;

/**
 * The terminal is narrower than the configured box, so re-solve the canvases at
 * the width it can actually show (frames cache per `width x height` grid, so
 * widening back is a cache hit). Debounced: dragging a window resizes in bursts,
 * and each rebuild is one ffmpeg/chafa run per canvas.
 */
export function resizeSplash(ctx: ExtensionContext, current: SessionState, width: number): void {
	if (!current.config.enabled) return;
	current.pendingWidth = width;
	if (current.resizeTimer !== undefined) clearTimeout(current.resizeTimer);
	const timer = setTimeout(() => {
		current.resizeTimer = undefined;
		applyPendingWidth(ctx, current);
	}, RESIZE_DEBOUNCE_MS);
	timer.unref?.();
	current.resizeTimer = timer;
}

function applyPendingWidth(ctx: ExtensionContext, current: SessionState): void {
	const target = current.pendingWidth;
	if (target === undefined) return;
	// A build in flight already owns the frame map; retry once it is done.
	if (current.building) {
		resizeSplash(ctx, current, target);
		return;
	}
	current.pendingWidth = undefined;
	const next = applyPlanWidth(current.config, target);
	if (next === current.config) return;
	void buildContent(ctx, current, false, next);
}
