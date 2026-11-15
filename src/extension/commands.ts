/**
 * `/splash` — the only user-facing command.
 *
 * Subcommands: on, off, freeze, rebuild, reload, status. Each one is a thin
 * adapter over the session state; the heavy lifting lives in `session.ts`.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describeConfig, describeConfigSource, formatSize, loadSessionConfig, type BannerConfig } from "../config.ts";
import { clearCache, preflight } from "../frames.ts";
import { clearImageCache } from "../images.ts";
import { describeListing, installHeader, restoreResourceListing } from "./header.ts";
import { bootstrap, buildContent } from "./session.ts";
import { contentSummary, describeImage, session } from "./state.ts";

export const USAGE = "usage: /splash on | off | freeze | rebuild | reload | status";

export const SUBCOMMANDS = ["on", "off", "freeze", "rebuild", "reload", "status"].map((value) => ({
	value,
	label: value,
	description: `/splash ${value}`,
}));

export async function handleSplashCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext, rawArgs: string): Promise<void> {
	const [sub = "status", ...rest] = rawArgs.trim().split(/\s+/).filter(Boolean);
	let current = session.current;

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
	session.current = current;

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
		case "reload": {
			// Re-read pi-chafa-banner.json. Everything downstream (frames, pixels,
			// banner config) is keyed by the old values, so drop it all and rebuild.
			const previous = current.config;
			const next = loadSessionConfig();
			current.config = next;
			if (next.size.width !== previous.size.width || next.size.height !== previous.size.height) {
				await clearCache(previous, current.theme?.getColorMode() ?? "truecolor");
				await clearImageCache(previous, current.imageBudget);
			}
			current.frames = undefined;
			current.images = undefined;
			current.imageRebuilds = 0;
			current.banner?.setConfig(next);
			current.banner?.setFrames(undefined);
			current.banner?.setImages(undefined);
			await buildContent(ctx, current, true);
			const summary = contentSummary(current);
			const warnings = next.source.warnings;
			const lines = [
				`pi-chafa-banner: ${summary ? `reloaded ${summary}` : `reload failed: ${current.status ?? "unknown error"}`}`,
				`config  ${describeConfigSource(next)}`,
			];
			for (const warning of warnings) lines.push(`warn    ${warning}`);
			ctx.ui.notify(lines.join("\n"), summary ? "info" : "warning");
			return;
		}
		case "status": {
			const tools = await preflight();
			const lines = [
				`config  ${describeConfig(current.config)}`,
				`source  ${describeConfigSource(current.config)}`,
				`header  ${current.installed ? (current.banner?.isVisible() ? "installed" : "hidden") : "not installed"}`,
				current.frames
					? `frames  ${current.frames.frames.length}/${current.frames.totalFrames} @ ${formatSize({ width: current.frames.width, height: current.frames.height })} ${current.frames.colorMode}${current.frames.fromCache ? " (cache)" : " (fresh)"}`
					: `frames  pending${current.status ? ` — ${current.status}` : ""}`,
				`image   ${describeImage(current)}`,
				`tools   ${tools.ok ? Object.values(tools.versions).join(" | ") : `missing: ${tools.missing.join(", ")}`}`,
				`listing ${describeListing(current)}`,
			];
			for (const warning of current.config.source.warnings) lines.push(`warn    ${warning}`);
			ctx.ui.notify(lines.join("\n"), "info");
			return;
		}
		default:
			ctx.ui.notify(`pi-chafa-banner: ${USAGE}`, "info");
	}
}
