/**
 * Session bootstrap and the background build.
 *
 * `bootstrap()` runs once on `session_start`: pick a renderer, install the
 * header, kick off the (slow) frame/pixel build. Everything that can fail is
 * caught and surfaced as a status line — the splash degrades, it never throws.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Banner } from "../banner.ts";
import { applySourceSize, loadSessionConfig, type BannerConfig } from "../config.ts";
import { loadFrames } from "../frames.ts";
import { clearImageCache, loadImageFrames, probeSourceSize } from "../images.ts";
import { kittyCapabilities } from "../kitty.ts";
import { collectResources, emptyResources, type BannerResources } from "../resources.ts";
import { installHeader } from "./header.ts";
import { createState, errorText, imageBudgetFor, resolveRenderer, session, type SessionState } from "./state.ts";

/** pi's own API handle, for the synchronous `getCommands()`/`getSettings()` probes. */
let cachedPi: ExtensionAPI | undefined;

/** Wait for a resize burst to settle before re-encoding pixels. */
const IMAGE_REBUILD_DEBOUNCE_MS = 300;
/** Telemetry only: how many times pixels were re-encoded this session. */

/**
 * Did the terminal shape change enough to warrant re-encoding the pixels?
 *
 * Both directions count: a narrower terminal needs a smaller grid to fit, and a
 * wider one would otherwise keep the small picture forever. The first build
 * (`undefined`) is not a rebuild — it is still in flight.
 */
export function needsImageRebuild(
	built: { maxColumns: number; maxRows: number } | undefined,
	budget: { maxColumns: number; maxRows: number },
): boolean {
	if (!built) return false;
	return built.maxColumns !== budget.maxColumns || built.maxRows !== budget.maxRows;
}

export async function buildContent(ctx: ExtensionContext, current: SessionState, force = false): Promise<void> {
	if (current.building) return;
	current.building = true;
	try {
		// `height: "auto"` needs the artwork's aspect ratio, and both renderers must
		// agree on the band height: chafa's canvas is otherwise a fixed 44x22 box
		// while the native grid follows the pixels, so the two modes would show
		// differently shaped splashes.
		if (current.config.heightAuto && current.config.gifPath) {
			try {
				const source = await probeSourceSize(current.config.gifPath);
				const applied = applySourceSize(current.config, source);
				if (applied !== current.config) {
					current.config = applied;
					current.banner?.setConfig(applied);
				}
			} catch {
				// Keep the width-derived guess; the build below reports real failures.
			}
		}
		if (current.renderer === "kitty") {
			const budget = imageBudgetFor(current);
			const images = await loadImageFrames(current.config, { ...budget, force });
			current.images = images;
			current.imageBudget = budget;
			current.status = undefined;
			current.banner?.setStatus(undefined);
			current.banner?.setImages(images);
		} else {
			const colorMode = current.theme?.getColorMode() ?? "truecolor";
			const frames = await loadFrames(current.config, colorMode, { force });
			current.frames = frames;
			current.status = undefined;
			current.banner?.setStatus(undefined);
			current.banner?.setFrames(frames);
		}
	} catch (error) {
		// Keep the chosen renderer: a failed build shows its placeholder card
		// rather than silently swapping layouts mid-session.
		current.frames = undefined;
		current.images = undefined;
		current.status = errorText(error);
		current.banner?.setStatus(current.status);
		current.banner?.setFrames(undefined);
		current.banner?.setImages(undefined);
		// Record the budget we attempted: otherwise every render would schedule the
		// same failing rebuild again (a 300 ms ffmpeg loop).
		current.imageBudget = imageBudgetFor(current);
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
			activeTheme: safeSettings().theme,
			availableThemes: ctx.ui.getAllThemes().map((theme) => theme.name),
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
	session.current = current;

	if (!config.enabled) {
		ctx.ui.notify("pi-chafa-banner: disabled (behavior.enabled is false in pi-chafa-banner.json)", "info");
		return current;
	}

	// Probe once per session: pi-tui reads PI_IMAGE_PROTOCOL / TERM_PROGRAM and
	// tmux/screen overrides here, so this must not be cached across processes.
	const images = await kittyCapabilities();
	current.capabilities = { images };
	const resolved = resolveRenderer(config, current.capabilities);
	current.renderer = resolved.renderer;
	current.rendererNoticeShown = Boolean(resolved.notice);
	if (resolved.notice) ctx.ui.notify(`pi-chafa-banner: ${resolved.notice}`, "info");

	installHeader(ctx, current);
	void buildContent(ctx, current);
	return current;
}

export async function refreshResources(ctx: ExtensionContext, current: SessionState, extra?: {
	contextFiles?: string[];
	skills?: string[];
}): Promise<void> {
	try {
		const next = await collectResources({
			cwd: ctx.cwd,
			commands: safeCommands(),
			settings: safeSettings(),
			model: ctx.model,
			activeTheme: safeSettings().theme,
			availableThemes: ctx.ui.getAllThemes().map((theme) => theme.name),
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

/**
 * Re-encode the image when the terminal changed shape under a header that was
 * built for a different grid.
 *
 * The comparison is against the budget the current pixels were encoded for, not
 * against "is the picture too big": a terminal that only *grows* leaves the
 * picture legal but tiny, and the old rule then never rebuilt it — a shrunk
 * splash stayed shrunk for the rest of the session. Because the budget is a pure
 * function of the terminal width and the configured size, comparing budgets also
 * terminates: one rebuild per distinct shape, no cap needed.
 */
export function scheduleImageRebuild(ctx: ExtensionContext, current: SessionState): void {
	if (current.renderer !== "kitty" || current.building) return;
	if (current.rebuildTimer !== undefined) return;
	if (!current.images) return;
	const budget = imageBudgetFor(current);
	// `undefined` means the very first build is still running; it will pick up
	// the current width on its own.
	if (!needsImageRebuild(current.imageBudget, budget)) return;
	current.imageRebuilds += 1;
	current.rebuildTimer = setTimeout(() => {
		current.rebuildTimer = undefined;
		void buildContent(ctx, current, true);
	}, IMAGE_REBUILD_DEBOUNCE_MS);
	current.rebuildTimer.unref?.();
}
