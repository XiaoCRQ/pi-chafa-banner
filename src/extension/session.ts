/**
 * Session bootstrap and the background build.
 *
 * `bootstrap()` runs once on `session_start`: install the header, kick off the
 * (slow) chafa build. Everything that can fail is caught and surfaced as a
 * status line — the splash degrades, it never throws.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Banner } from "../banner.ts";
import { applySourceSize, loadSessionConfig, type BannerConfig } from "../config.ts";
import { loadFrames } from "../frames.ts";
import { probeSourceSize } from "../pipeline/process.ts";
import { collectResources, emptyResources, type BannerResources } from "../resources.ts";
import { installHeader } from "./header.ts";
import { createState, errorText, session, type SessionState } from "./state.ts";

/** pi's own API handle, for the synchronous `getCommands()`/`getSettings()` probes. */
let cachedPi: ExtensionAPI | undefined;

export async function buildContent(ctx: ExtensionContext, current: SessionState, force = false): Promise<void> {
	if (current.building) return;
	current.building = true;
	try {
		// `height: "auto"` needs the artwork's aspect ratio: a cell is roughly twice
		// as tall as it is wide, so a 2:1 gif at 44 columns wants 22 rows.
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
		const colorMode = current.theme?.getColorMode() ?? "truecolor";
		const frames = await loadFrames(current.config, colorMode, { force });
		current.frames = frames;
		current.status = undefined;
		current.banner?.setStatus(undefined);
		current.banner?.setFrames(frames);
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
	current.ctx = ctx;
	session.current = current;

	if (!config.enabled) {
		ctx.ui.notify("pi-chafa-banner: disabled (behavior.enabled is false in pi-chafa-banner.json)", "info");
		return current;
	}

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

/** Rebuild on demand (`/splash rebuild|reload`). */
export function scheduleRebuild(ctx: ExtensionContext, current: SessionState): void {
	if (current.building) return;
	void buildContent(ctx, current, true);
}
