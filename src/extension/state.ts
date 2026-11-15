/**
 * Shared session state for the extension.
 *
 * One process runs one pi session per TUI, so a module-level holder is enough;
 * `session.current` is replaced wholesale on bootstrap and cleared on shutdown.
 */

import type { ExtensionContext, Theme, TUI } from "@earendil-works/pi-coding-agent";
import type { Banner } from "../banner.ts";
import type { BannerConfig } from "../config.ts";
import { FrameError, type FrameSet } from "../frames.ts";
import type { DetachedListing } from "../host.ts";
import { describeGap, type ImageFrameSet } from "../images.ts";
import { imageBandBudget, type ImageBandBudget } from "../layout.ts";
import { formatSize } from "../config.ts";
import type { BannerResources } from "../resources.ts";

type ImageProtocol = "kitty" | "iterm2" | null;

export interface SessionState {
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

/** The live session, or `undefined` before `session_start` / after shutdown. */
export const session: { current?: SessionState } = {};

export function errorText(error: unknown): string {
	if (error instanceof FrameError) return error.message;
	if (error instanceof Error) return error.message;
	return String(error);
}

export function createState(config: BannerConfig, resources: BannerResources): SessionState {
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


export function imageBudgetFor(current: SessionState): ImageBandBudget {
	return imageBandBudget({
		cols: current.tui?.terminal?.columns ?? 100,
		size: current.config.size,
	});
}

export function describeImage(current: SessionState): string {
	if (current.renderer !== "kitty") return "off (renderer=chars)";
	const images = current.images;
	if (!images) return current.status ? `unavailable: ${current.status}` : "pending";
	const mode = images.frames.length < 2 ? "static" : current.config.kittyMode;
	return [
		`kitty ${images.columns}x${images.rows}c`,
		`${images.frames.length}/${images.totalFrames}f`,
		`gap ${describeGap(images)}`,
		mode,
		`id=${images.imageId}`,
		images.fromCache ? "cache" : "build",
	].join(" ");
}

/** One-line summary of what was built, for `/splash rebuild|reload`. */
export function contentSummary(current: SessionState): string | undefined {
	if (current.renderer === "kitty") {
		const images = current.images;
		if (!images) return undefined;
		return `${images.frames.length}/${images.totalFrames} image frames at ${images.columns}x${images.rows} cells`;
	}
	const frames = current.frames;
	if (!frames) return undefined;
	return `${frames.frames.length} frames at ${formatSize({ width: frames.width, height: frames.height })}`;
}
