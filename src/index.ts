/**
 * pi-chafa-banner — an animated chafa image splash for pi's startup header.
 *
 * Why the header and not a message/overlay: `ctx.ui.setHeader()` replaces the
 * built-in logo inside pi's `headerContainer`, which is a normal child of the
 * document. That means the splash lives at the top of the transcript, scrolls
 * away naturally as the conversation grows, never captures input, and is
 * disposed automatically by pi when the session reloads or shuts down.
 */

import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	Theme,
	TUI,
} from "@earendil-works/pi-coding-agent";
import { Banner } from "./banner.ts";
import { describeConfig, formatSize, loadConfig, parseSize, type BannerConfig } from "./config.ts";
import { clearCache, FrameError, loadFrames, preflight, type FrameSet } from "./frames.ts";
import { detachResourceListing, type DetachedListing } from "./host.ts";
import { clearImageCache, loadImageFrames, type ImageFrameSet } from "./images.ts";
import { kittyCapabilities } from "./kitty.ts";
import { imageBandBudget, type ImageBandBudget } from "./layout.ts";
import { collectResources, emptyResources, type BannerResources } from "./resources.ts";

/** Inline-image support as reported by pi-tui's capability probe. */
type ImageProtocol = "kitty" | "iterm2" | null;

interface SessionState {
	config: BannerConfig;
	resources: BannerResources;
	/** `kitty` = native image band; `chars` = chafa frames. */
	renderer: "chars" | "kitty";
	frames?: FrameSet;
	images?: ImageFrameSet;
	capabilities?: { images: ImageProtocol };
	/** Grid the current image was built for; compared on resize. */
	imageBudget?: ImageBandBudget;
	rebuildTimer?: ReturnType<typeof setTimeout>;
	imageRebuilds: number;
	banner?: Banner;
	tui?: TUI;
	theme?: Theme;
	building: boolean;
	installed: boolean;
	status?: string;
	notified: boolean;
	rendererNoticeShown: boolean;
	/** pi's own `[Context]/[Skills]/…` listing, once detached from the tree. */
	detached?: DetachedListing;
	detachAttempts: number;
	lastDetachAt: number;
}

let state: SessionState | undefined;

const USAGE = "usage: /splash on | off | freeze | rebuild | size <WxH> | status";

/** Give a late-mounting header a few seconds to expose its sibling listing. */
const MAX_DETACH_ATTEMPTS = 20;
const DETACH_COOLDOWN_MS = 250;
/** Wait for a resize burst to settle before re-encoding pixels. */
const IMAGE_REBUILD_DEBOUNCE_MS = 300;
/** Encoding is expensive; two corrections per session is enough. */
const MAX_IMAGE_REBUILDS = 2;

const SUBCOMMANDS = ["on", "off", "freeze", "rebuild", "size", "status"].map((value) => ({
	value,
	label: value,
	description: `/splash ${value}`,
}));

function errorText(error: unknown): string {
	if (error instanceof FrameError) return error.message;
	if (error instanceof Error) return error.message;
	return String(error);
}

function createState(config: BannerConfig, resources: BannerResources): SessionState {
	return {
		config,
		resources,
		renderer: "chars",
		imageRebuilds: 0,
		building: false,
		installed: false,
		notified: false,
		rendererNoticeShown: false,
		detachAttempts: 0,
		lastDetachAt: 0,
	};
}

/**
 * Pick the renderer for this session.
 *
 * `auto` never nags: it silently uses characters unless the terminal really
 * speaks kitty. An explicit `kitty` explains itself once when it cannot be
 * honoured, because the user asked for it by name.
 */
export function resolveRenderer(
	config: BannerConfig,
	caps: { images: ImageProtocol } | undefined,
): { renderer: "chars" | "kitty"; notice?: string } {
	const images = caps?.images ?? null;
	if (config.renderer === "chars") return { renderer: "chars" };
	if (images === "kitty") return { renderer: "kitty" };
	if (config.renderer === "auto") return { renderer: "chars" };
	if (images === "iterm2") {
		return {
			renderer: "chars",
			notice: "iTerm2 inline images are not implemented yet; falling back to Chars",
		};
	}
	return {
		renderer: "chars",
		notice: "kitty renderer requested but this terminal reports no inline image protocol; falling back to Chars",
	};
}

/** Grid budget for the current terminal — shared by the build and resize paths. */
function imageBudgetFor(current: SessionState): ImageBandBudget {
	return imageBandBudget({
		cols: current.tui?.terminal?.columns ?? 100,
		size: current.config.size,
	});
}

function installHeader(ctx: ExtensionContext, current: SessionState): void {
	ctx.ui.setHeader((tui, theme) => {
		current.tui = tui;
		current.theme = theme;
		const banner = new Banner(tui, theme, {
			config: current.config,
			resources: current.resources,
			frames: current.frames,
			images: current.images,
			renderer: current.renderer,
			status: current.status,
		});
		current.banner = banner;
		current.installed = true;
		banner.start();

		const component = {
			render: (width: number) => {
				// pi only mounts the component after the factory returns, so the
				// first few renders are the earliest safe moments to look for the
				// resource listing in the live tree.
				attemptDetach();
				// A terminal resize changes the cell budget the pixels were encoded
				// for; re-encode off the render path once things settle.
				scheduleImageRebuild(ctx, current);
				return banner.render(width);
			},
			invalidate: () => banner.invalidate(),
			dispose: () => {
				banner.dispose();
				if (current.banner === banner) current.banner = undefined;
				current.installed = false;
			},
		};

		/**
		 * Drop pi's `[Context] / [Skills] / [Extensions]` listing, which would
		 * otherwise be printed directly under the splash (see host.ts). Deferred
		 * via a microtask: mutating the tree mid-render would surprise pi's
		 * renderer, and this runs right after the component gets mounted.
		 */
		const attemptDetach = () => {
			if (!current.config.hideResources || current.detached) return;
			if (current.detachAttempts >= MAX_DETACH_ATTEMPTS) return;
			// Render happens per animation tick; a cooldown keeps a not-yet-mounted
			// tree from burning the whole budget in the first few milliseconds.
			const now = Date.now();
			if (now - current.lastDetachAt < DETACH_COOLDOWN_MS) return;
			current.lastDetachAt = now;
			current.detachAttempts += 1;
			queueMicrotask(() => {
				if (current.detached || current.banner !== banner) return;
				try {
					const detached = detachResourceListing(current.tui ?? tui, component);
					if (!detached) return;
					current.detached = detached;
					current.tui?.requestRender();
				} catch {
					// pi's tree is private: a failed detach just leaves the listing visible.
				}
			});
		};
		attemptDetach();

		return component;
	});
	// Painting the header is enough to trigger a layout pass, but request one
	// explicitly so the splash appears before the first keystroke.
	current.tui?.requestRender();
}

/** Put pi's loaded-resource listing back into the tree (`/splash off`). */
function restoreResourceListing(current: SessionState): void {
	const detached = current.detached;
	if (!detached) return;
	current.detached = undefined;
	try {
		detached.restore();
	} catch {
		// Best effort: a failed restore only means the stock listing stays hidden.
	}
}

function describeListing(current: SessionState): string {
	if (!current.config.hideResources) return "kept (PI_BANNER_HIDE_RESOURCES=0)";
	if (current.detached) return "hidden (pi's Context/Skills/Extensions panel detached)";
	return 'visible — detach failed; set "quietStartup": true in pi settings instead';
}

/**
 * Re-encode the image when the terminal changed shape under a header that was
 * built for a different grid. Debounced and capped: a resize storm must not
 * turn into an ffmpeg loop.
 */
function scheduleImageRebuild(ctx: ExtensionContext, current: SessionState): void {
	if (current.renderer !== "kitty" || current.building) return;
	if (current.rebuildTimer !== undefined) return;
	if (current.imageRebuilds >= MAX_IMAGE_REBUILDS) return;
	const images = current.images;
	if (!images) return;
	const budget = imageBudgetFor(current);
	// Width mismatch is fatal (the band would overflow), height mismatch only
	// wastes rows — both are worth one rebuild.
	if (images.columns <= budget.maxColumns && images.rows <= budget.maxRows) return;
	current.imageRebuilds += 1;
	current.rebuildTimer = setTimeout(() => {
		current.rebuildTimer = undefined;
		void buildContent(ctx, current, true);
	}, IMAGE_REBUILD_DEBOUNCE_MS);
	current.rebuildTimer.unref?.();
}

/**
 * `/splash status` line for the image path. Kept terse but complete: protocol,
 * grid, frame budget, gap, animation mode, image id and cache provenance.
 */
function describeImage(current: SessionState): string {
	if (current.renderer !== "kitty") return "off (renderer=chars)";
	const images = current.images;
	if (!images) return current.status ? `unavailable: ${current.status}` : "pending";
	const mode = images.frames.length < 2 ? "static" : current.config.kittyMode;
	return [
		`kitty ${images.columns}x${images.rows}c`,
		`${images.frames.length}/${images.totalFrames}f`,
		`gap ${images.gapMs}ms`,
		mode,
		`id=${images.imageId}`,
		images.fromCache ? "cache" : "build",
	].join(" ");
}

/** One-line summary of whatever the current renderer produced. */
function contentSummary(current: SessionState): string | undefined {
	if (current.renderer === "kitty") {
		const images = current.images;
		if (!images) return undefined;
		return `${images.frames.length}/${images.totalFrames} image frames at ${images.columns}x${images.rows} cells`;
	}
	const frames = current.frames;
	if (!frames) return undefined;
	return `${frames.frames.length} frames at ${formatSize({ width: frames.width, height: frames.height })}`;
}

/**
 * Build the renderer's payload off the event loop; update the installed header
 * when ready. One code path for both renderers so the notice/status handling
 * cannot drift apart.
 */
async function buildContent(ctx: ExtensionContext, current: SessionState, force = false): Promise<void> {
	if (current.building) return;
	current.building = true;
	try {
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

let cachedPi: ExtensionAPI | undefined;

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

async function bootstrap(pi: ExtensionAPI, ctx: ExtensionContext): Promise<SessionState> {
	cachedPi = pi;
	const config = loadConfig();
	const resources = await collectFor(ctx, config);
	const current = createState(config, resources);
	state = current;

	if (!config.enabled) {
		ctx.ui.notify("pi-chafa-banner: disabled (PI_BANNER_DISABLED=1)", "info");
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

async function refreshResources(ctx: ExtensionContext, current: SessionState, extra?: {
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

async function handleSplashCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext, rawArgs: string): Promise<void> {
	const [sub = "status", ...rest] = rawArgs.trim().split(/\s+/).filter(Boolean);
	let current = state;

	if (sub === "on" && !current) {
		current = await bootstrap(pi, ctx);
		if (current.config.enabled && !current.installed) installHeader(ctx, current);
		ctx.ui.notify("pi-chafa-banner: on", "info");
		return;
	}

	if (!current) {
		ctx.ui.notify(`pi-chafa-banner: no active session yet. ${USAGE}`, "warning");
		return;
	}

	switch (sub) {
		case "on": {
			current.config = { ...current.config, enabled: true };
			current.detachAttempts = 0;
			current.lastDetachAt = 0;
			if (!current.installed) installHeader(ctx, current);
			current.banner?.setVisible(true);
			if (current.renderer === "kitty" ? !current.images : !current.frames) void buildContent(ctx, current);
			ctx.ui.notify("pi-chafa-banner: on", "info");
			return;
		}
		case "off": {
			current.config = { ...current.config, enabled: false };
			current.banner?.setVisible(false);
			current.banner?.dispose();
			current.banner = undefined;
			// Put pi's `[Context]/[Skills]/…` listing back before handing the header
			// back, so `off` really restores the stock startup screen.
			restoreResourceListing(current);
			// Restoring undefined brings pi's builtin header back.
			ctx.ui.setHeader(undefined);
			current.installed = false;
			current.tui?.requestRender();
			ctx.ui.notify("pi-chafa-banner: off (builtin header restored)", "info");
			return;
		}
		case "freeze": {
			const frozen = current.banner?.toggleFreeze();
			ctx.ui.notify(
				`pi-chafa-banner: ${frozen === undefined ? "no header installed" : frozen ? "frozen" : "animating"}`,
				"info",
			);
			return;
		}
		case "rebuild": {
			ctx.ui.notify(
				current.renderer === "kitty" ? "pi-chafa-banner: rebuilding image…" : "pi-chafa-banner: rebuilding frames…",
				"info",
			);
			// A rebuild is the user's "try again": allow the resize guard to run
			// again afterwards.
			current.imageRebuilds = 0;
			await buildContent(ctx, current, true);
			const summary = contentSummary(current);
			ctx.ui.notify(
				summary
					? `pi-chafa-banner: rebuilt ${summary} (${formatSize(current.config.size)})`
					: `pi-chafa-banner: rebuild failed: ${current.status ?? "unknown error"}`,
				summary ? "info" : "warning",
			);
			return;
		}
		case "size": {
			const requested = rest[0];
			if (!requested) {
				ctx.ui.notify(`pi-chafa-banner: size is ${formatSize(current.config.size)}. ${USAGE}`, "info");
				return;
			}
			const parsed = parseSize(requested, current.config.size);
			if (!/^\s*\d+\s*[xX*]\s*\d+\s*$/.test(requested)) {
				ctx.ui.notify(`pi-chafa-banner: invalid size "${requested}". ${USAGE}`, "warning");
				return;
			}
			const previous = current.config;
			current.config = { ...current.config, size: parsed };
			// Cache entries are keyed by size, so drop the OLD size before switching;
			// clearing after the assignment deleted the new (nonexistent) key instead.
			await clearCache(previous, current.theme?.getColorMode() ?? "truecolor");
			// The image cache is keyed by the cell grid, so drop the OLD key too.
			await clearImageCache(previous, current.imageBudget);
			current.frames = undefined;
			current.images = undefined;
			current.imageRebuilds = 0;
			current.banner?.setConfig(current.config);
			current.banner?.setFrames(undefined);
			current.banner?.setImages(undefined);
			await buildContent(ctx, current, true);
			const summary = contentSummary(current);
			ctx.ui.notify(
				summary
					? `pi-chafa-banner: size ${formatSize(parsed)}`
					: `pi-chafa-banner: size ${formatSize(parsed)} failed: ${current.status ?? "unknown"}`,
				summary ? "info" : "warning",
			);
			return;
		}
		case "status": {
			const tools = await preflight();
			const lines = [
				`config  ${describeConfig(current.config)}`,
				`header  ${current.installed ? (current.banner?.isVisible() ? "installed" : "hidden") : "not installed"}`,
				current.frames
					? `frames  ${current.frames.frames.length}/${current.frames.totalFrames} @ ${formatSize({ width: current.frames.width, height: current.frames.height })} ${current.frames.colorMode}${current.frames.fromCache ? " (cache)" : " (fresh)"}`
					: `frames  pending${current.status ? ` — ${current.status}` : ""}`,
				`image   ${describeImage(current)}`,
				`tools   ${tools.ok ? Object.values(tools.versions).join(" | ") : `missing: ${tools.missing.join(", ")}`}`,
				`listing ${describeListing(current)}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
			return;
		}
		default:
			ctx.ui.notify(`pi-chafa-banner: ${USAGE}`, "info");
	}
}

export default function piChafaBanner(pi: ExtensionAPI): void {
	cachedPi = pi;

	pi.on("session_start", async (_event, ctx) => {
		try {
			if (ctx.mode !== "tui") return;
			await bootstrap(pi, ctx);
		} catch (error) {
			ctx.ui.notify(`pi-chafa-banner: ${errorText(error)}`, "warning");
		}
	});

	// Streaming causes pi to re-render the document continuously; stop our timer
	// so the splash cannot add jank to token streaming.
	pi.on("agent_start", () => {
		state?.banner?.pause();
	});

	pi.on("agent_end", () => {
		state?.banner?.resume();
	});

	// First turn is when pi has actually loaded context files and skills, so use
	// the resolved system prompt options to fill in the panel accurately.
	pi.on("before_agent_start", (event, ctx) => {
		const current = state;
		if (!current) return;
		try {
			const options = event.systemPromptOptions;
			const contextFiles = (options.contextFiles ?? []).map((file) => file.path);
			const skills = (options.skills ?? []).map((skill) => skill.name);
			void refreshResources(ctx, current, { contextFiles, skills });
		} catch {
			// ignore malformed events
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		try {
			state?.banner?.dispose();
			state = undefined;
			ctx.ui.setHeader(undefined);
		} catch {
			// shutdown must never fail
		}
	});

	pi.registerCommand("splash", {
		description: "Control the chafa startup banner (on|off|freeze|rebuild|size|status)",
		getArgumentCompletions: (prefix) => {
			const filtered = SUBCOMMANDS.filter((entry) => entry.value.startsWith(prefix.trim()));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			try {
				await handleSplashCommand(pi, ctx, args);
			} catch (error) {
				ctx.ui.notify(`pi-chafa-banner: ${errorText(error)}`, "error");
			}
		},
	});
}
