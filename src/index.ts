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
import { collectResources, emptyResources, type BannerResources } from "./resources.ts";

interface SessionState {
	config: BannerConfig;
	resources: BannerResources;
	frames?: FrameSet;
	banner?: Banner;
	tui?: TUI;
	theme?: Theme;
	building: boolean;
	installed: boolean;
	status?: string;
	notified: boolean;
	rendererNoticeShown: boolean;
}

let state: SessionState | undefined;

const USAGE = "usage: /splash on | off | freeze | rebuild | size <WxH> | status";

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
		building: false,
		installed: false,
		notified: false,
		rendererNoticeShown: false,
	};
}

/**
 * `kitty` is a forward-looking option: real Kitty graphics protocol images are
 * multi-row escape sequences that pi's line-oriented header renderer cannot
 * account for, so today we detect an image-capable terminal, say so once, and
 * render characters instead. Keeping the config surface stable means a future
 * implementation only has to swap the frame source.
 */
function resolveRenderer(config: BannerConfig): { renderer: "chars" | "kitty"; notice?: string } {
	if (config.renderer !== "kitty") return { renderer: "chars" };
	const capable =
		Boolean(process.env.KITTY_WINDOW_ID) ||
		/kitty|wezterm|iterm/i.test(process.env.TERM_PROGRAM ?? "") ||
		/kitty|wezterm/i.test(process.env.TERM ?? "");
	return {
		renderer: "chars",
		notice: capable
			? "kitty graphics protocol detected, but only character frames are implemented; using chars"
			: "kitty renderer requested but this terminal has no known graphics protocol; using chars",
	};
}

function installHeader(ctx: ExtensionContext, current: SessionState): void {
	ctx.ui.setHeader((tui, theme) => {
		current.tui = tui;
		current.theme = theme;
		const banner = new Banner(tui, theme, {
			config: current.config,
			resources: current.resources,
			frames: current.frames,
			status: current.status,
		});
		current.banner = banner;
		current.installed = true;
		banner.start();
		return {
			render: (width: number) => banner.render(width),
			invalidate: () => banner.invalidate(),
			dispose: () => {
				banner.dispose();
				if (current.banner === banner) current.banner = undefined;
				current.installed = false;
			},
		};
	});
	// Painting the header is enough to trigger a layout pass, but request one
	// explicitly so the splash appears before the first keystroke.
	current.tui?.requestRender();
}

/** Build frames off the event loop; update the installed header when ready. */
async function buildFrames(ctx: ExtensionContext, current: SessionState, force = false): Promise<void> {
	if (current.building) return;
	current.building = true;
	try {
		const colorMode = current.theme?.getColorMode() ?? "truecolor";
		const frames = await loadFrames(current.config, colorMode, { force });
		current.frames = frames;
		current.status = undefined;
		current.banner?.setStatus(undefined);
		current.banner?.setFrames(frames);
	} catch (error) {
		current.frames = undefined;
		current.status = errorText(error);
		current.banner?.setStatus(current.status);
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

	const renderer = resolveRenderer(config);
	current.rendererNoticeShown = Boolean(renderer.notice);
	if (renderer.notice) ctx.ui.notify(`pi-chafa-banner: ${renderer.notice}`, "info");

	installHeader(ctx, current);
	void buildFrames(ctx, current);
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
			if (!current.installed) installHeader(ctx, current);
			current.banner?.setVisible(true);
			if (!current.frames) void buildFrames(ctx, current);
			ctx.ui.notify("pi-chafa-banner: on", "info");
			return;
		}
		case "off": {
			current.config = { ...current.config, enabled: false };
			current.banner?.setVisible(false);
			current.banner?.dispose();
			current.banner = undefined;
			// Restoring undefined brings pi's builtin header back.
			ctx.ui.setHeader(undefined);
			current.installed = false;
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
			ctx.ui.notify("pi-chafa-banner: rebuilding frames…", "info");
			await buildFrames(ctx, current, true);
			ctx.ui.notify(
				current.frames
					? `pi-chafa-banner: rebuilt ${current.frames.frames.length} frames (${formatSize(current.config.size)})`
					: `pi-chafa-banner: rebuild failed: ${current.status ?? "unknown error"}`,
				current.frames ? "info" : "warning",
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
			current.frames = undefined;
			current.banner?.setConfig(current.config);
			current.banner?.setFrames(undefined);
			await buildFrames(ctx, current, true);
			ctx.ui.notify(
				current.frames
					? `pi-chafa-banner: size ${formatSize(parsed)}`
					: `pi-chafa-banner: size ${formatSize(parsed)} failed: ${current.status ?? "unknown"}`,
				current.frames ? "info" : "warning",
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
				`tools   ${tools.ok ? Object.values(tools.versions).join(" | ") : `missing: ${tools.missing.join(", ")}`}`,
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
