/**
 * Shared session state for the extension.
 *
 * One process runs one pi session per TUI, so a module-level holder is enough;
 * `session.current` is replaced wholesale on bootstrap and cleared on shutdown.
 */

import type { ExtensionContext, Theme, TUI } from "@earendil-works/pi-coding-agent";
import type { Banner } from "../banner.ts";
import { formatSize, type BannerConfig } from "../config.ts";
import { FrameError, type FrameSet } from "../frames.ts";
import type { DetachedListing } from "../host.ts";
import type { BannerResources } from "../resources.ts";

export interface SessionState {
	config: BannerConfig;
	resources: BannerResources;
	frames?: FrameSet;
	banner?: Banner;
	tui?: TUI;
	ctx?: ExtensionContext;
	theme?: Theme;
	building: boolean;
	installed: boolean;
	status?: string;
	notified: boolean;
	/** pi's own `[Context]/[Skills]/…` listing, once detached from the tree. */
	detached?: DetachedListing;
	detachAttempts: number;
	lastDetachAt: number;
}

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
		building: false,
		installed: false,
		notified: false,
		detachAttempts: 0,
		lastDetachAt: 0,
	};
}

/** One-line summary of what was built, for `/splash rebuild|reload`. */
export function contentSummary(current: SessionState): string | undefined {
	const frames = current.frames;
	if (!frames) return undefined;
	return `${frames.frames.length} frames at ${formatSize({ width: frames.width, height: frames.height })}`;
}
