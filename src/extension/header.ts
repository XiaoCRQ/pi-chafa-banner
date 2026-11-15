/**
 * Header installation and the pi component-tree side effects it needs.
 *
 * Everything here is in-memory and reversible: pi's own resource listing is
 * detached (never patched) and restored on `/splash off` or shutdown.
 */

import type { ExtensionContext, TUI } from "@earendil-works/pi-coding-agent";
import { Banner } from "../banner.ts";
import { detachResourceListing } from "../host.ts";
import { maxVisibleWidth, padVisible, truncateToWidth } from "../text.ts";
import { session, type SessionState } from "./state.ts";
import { scheduleImageRebuild } from "./session.ts";

const MAX_DETACH_ATTEMPTS = 20;
const DETACH_COOLDOWN_MS = 250;

export function installHeader(ctx: ExtensionContext, current: SessionState): void {
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


export function restoreResourceListing(current: SessionState): void {
	const detached = current.detached;
	if (!detached) return;
	current.detached = undefined;
	try {
		detached.restore();
	} catch {
		// Best effort: a failed restore only means the stock listing stays hidden.
	}
}

export function describeListing(current: SessionState): string {
	if (!current.config.hideResources) return "kept (behavior.hidePiResourceList is false)";
	if (current.detached) return "hidden (pi's Context/Skills/Extensions panel detached)";
	return 'visible — detach failed; set "quietStartup": true in pi settings instead';
}
