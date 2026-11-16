/**
 * The header component itself.
 *
 * pi calls `render(width)` synchronously on every frame, so all animation frames
 * are pre-rendered by `frames.ts` and this class only indexes into them. The
 * timer just bumps the index, invalidates, and asks pi for a redraw.
 *
 * Layout lives in `layout/render-tree.ts`: this class owns the lifecycle (timer,
 * pause/resume, freeze, dispose) and hands the tree renderer the root box. Every
 * window and canvas is a `LayoutNode` from the config, so there is exactly one
 * render path and no hard-coded two-column split here anymore.
 *
 * Errors stay visible: a structural config error and a `LayoutError` raised by
 * the size allocation both render the `LAYOUT ERROR` card. `render()` never
 * throws into pi.
 *
 * Lifecycle: created inside the `setHeader` factory (which hands us the live
 * `tui` + `theme`), paused while the agent is streaming, disposed on
 * session shutdown / header replacement.
 */

import type { Component, Theme, TUI } from "@earendil-works/pi-coding-agent";
import type { BannerConfig } from "../config.ts";
import type { FrameSet } from "../frames.ts";
import type { ChafaPlan } from "../layout/tree.ts";
import { centerBlock } from "../layout/compose.ts";
import { themePainter, type Painter } from "../layout/box.ts";
import { splashRows } from "../layout/metrics.ts";
import { renderLayoutError, renderSplash, type RenderContext } from "../layout/render-tree.ts";
import { DEFAULT_FRAME_DELAY_MS } from "../pipeline/timing.ts";
import type { BannerResources } from "../resources.ts";
import { truncateToWidth } from "../text.ts";
import { buildStatusLine, contentContext } from "./panels.ts";

export interface BannerInit {
	config: BannerConfig;
	resources: BannerResources;
	/**
	 * Frames per `ChafaPlan.key`. A bare `FrameSet` is wrapped by `framesByKey()`
	 * so single-canvas callers (tests, previews) keep working.
	 */
	frames?: Map<string, FrameSet> | FrameSet;
	status?: string;
}

/**
 * Wrap one canvas in the keyed map the renderer expects.
 *
 * `plan` is the canvas the frames were built for; when it is unknown the entry
 * still renders because a one-entry map is matched to any node.
 */
export function framesByKey(plan: ChafaPlan | undefined, frames: FrameSet | undefined): Map<string, FrameSet> | undefined {
	if (!frames) return undefined;
	return new Map([[plan?.key ?? "", frames]]);
}

export class Banner implements Component {
	/** Floor between two frames: below this the redraw churn is not worth it. */
	private static readonly MIN_FRAME_MS = 20;

	private readonly theme: Theme;
	private painter: Painter;
	private config: BannerConfig;
	private resources: BannerResources;
	private frames: Map<string, FrameSet> | undefined;
	private status: string | undefined;
	private frameIndex = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;
	/**
	 * Session hook: the terminal can show a narrower box than the frames were
	 * built for, so the session re-solves the canvases off the render path.
	 */
	onWidthChange?: (width: number) => void;
	/** Last width already asked for; keeps an animation tick from re-asking. */
	private requestedWidth: number | undefined;
	private visible: boolean;
	private frozen: boolean;
	private paused = false;
	private disposed = false;

	constructor(
		private readonly tui: TUI,
		theme: Theme,
		init: BannerInit,
	) {
		this.theme = theme;
		this.painter = themePainter(theme, init.config.theme);
		this.config = init.config;
		this.resources = init.resources;
		this.frames = normalizeFrames(init.config, init.frames);
		this.status = init.status;
		this.visible = init.config.enabled;
		this.frozen = init.config.static;
	}

	// -- data ---------------------------------------------------------------

	setFrames(frames: Map<string, FrameSet> | FrameSet | undefined): void {
		this.frames = normalizeFrames(this.config, frames);
		this.requestedWidth = undefined;
		const count = this.frameCount();
		if (count === 0) this.frameIndex = 0;
		else this.frameIndex %= count;
		this.start();
	}

	setResources(resources: BannerResources): void {
		this.resources = resources;
		this.invalidate();
	}

	setStatus(status: string | undefined): void {
		this.status = status;
		this.invalidate();
	}

	setConfig(config: BannerConfig): void {
		this.config = config;
		this.requestedWidth = undefined;
		// `/splash reload` may have changed the palette; rebuild the painter so the
		// next render picks it up without recycling the header component.
		this.painter = themePainter(this.theme, config.theme);
		this.frozen = config.static || this.frozen;
		this.visible = config.enabled;
		if (!this.visible) this.stopTimer();
		this.invalidate();
	}

	/** `/splash on|off`: off restores pi's builtin header in index.ts. */
	setVisible(visible: boolean): void {
		this.visible = visible;
		if (visible) this.start();
		else this.stopTimer();
		this.invalidate();
	}

	isVisible(): boolean {
		return this.visible;
	}

	/**
	 * Jump to a specific frame without waiting for the timer. Used by
	 * scripts/preview.ts and the tests; the animation timer is unaffected.
	 */
	setFrameIndex(index: number): void {
		const count = this.frameCount();
		this.frameIndex = count === 0 ? 0 : ((Math.floor(index) % count) + count) % count;
		this.invalidate();
	}

	/** `/splash freeze`: hold the current frame (or resume animating). */
	toggleFreeze(): boolean {
		this.frozen = !this.frozen;
		if (this.frozen) this.stopTimer();
		else this.start();
		this.invalidate();
		return this.frozen;
	}

	isFrozen(): boolean {
		return this.frozen;
	}

	/** The canvas that drives the animation clock (first chafa node with frames). */
	private primaryFrames(): FrameSet | undefined {
		const frames = this.frames;
		if (!frames || frames.size === 0) return undefined;
		for (const plan of this.config.plans) {
			const set = frames.get(plan.key);
			if (set) return set;
		}
		return frames.values().next().value;
	}

	private frameCount(): number {
		return this.primaryFrames()?.frames.length ?? 0;
	}

	// -- animation ----------------------------------------------------------

	start(): void {
		this.stopTimer();
		if (this.disposed || !this.visible || this.paused) return;
		// Static mode = one frame, zero timers, zero requestRender churn.
		if (this.frozen || this.config.static) return;
		if (this.frameCount() < 2) return;
		this.scheduleTick();
	}

	/**
	 * Delay for the frame currently on screen.
	 *
	 * A gif has no frame rate: every frame carries its own delay, and sampling
	 * every Nth frame (`stride`) means each kept frame has to stay up N times
	 * longer — that is what `delays` already encode. `image.fps` is an explicit
	 * override for people who want a fixed rate regardless of the gif.
	 */
	private frameDelay(): number {
		const fps = this.config.fps;
		if (typeof fps === "number" && fps > 0) return Math.max(Banner.MIN_FRAME_MS, Math.round(1000 / fps));
		const delay = this.primaryFrames()?.delays[this.frameIndex];
		return Math.max(Banner.MIN_FRAME_MS, Math.round(delay ?? DEFAULT_FRAME_DELAY_MS));
	}

	/**
	 * Self-rescheduling tick: `setInterval` cannot honour per-frame delays, and a
	 * `setTimeout` chain keeps the loop honest without drifting (each tick is
	 * scheduled after the render request, so slow frames never pile up).
	 */
	private scheduleTick(): void {
		this.timer = setTimeout(() => {
			this.timer = undefined;
			if (this.disposed || this.paused || this.frozen || !this.visible) return;
			const total = this.frameCount();
			if (total < 2) return;
			this.frameIndex = (this.frameIndex + 1) % total;
			this.invalidate();
			this.tui.requestRender();
			this.scheduleTick();
		}, this.frameDelay());
		// Never keep the process alive just to animate a splash.
		this.timer.unref?.();
	}

	stopTimer(): void {
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}

	/** Fired on agent_start: streaming re-renders the document constantly. */
	pause(): void {
		if (this.paused) return;
		this.paused = true;
		this.stopTimer();
	}

	/** Fired on agent_end. */
	resume(): void {
		this.paused = false;
		this.start();
	}

	dispose(): void {
		this.disposed = true;
		this.stopTimer();
		// Drop the prerendered frames; a long session should not keep them alive
		// behind a header the user has already replaced.
		this.frames = undefined;
	}

	invalidate(): void {
		// Nothing cached: render() is a pure composition of pre-built strings.
		// The method is required by the Component contract.
	}

	statusLine(): string {
		return buildStatusLine(this.config, this.primaryFrames(), this.frozen);
	}

	// -- rendering ----------------------------------------------------------

	private renderContext(): RenderContext {
		const primary = this.primaryFrames();
		const context: RenderContext = {
			painter: this.painter,
			plans: this.config.plans,
			frames: this.frames ?? new Map<string, FrameSet>(),
			frameIndex: this.frameIndex,
			content: contentContext(
				this.config,
				this.resources,
				primary ? `${primary.frames.length}/${primary.totalFrames}` : undefined,
			),
			settings: this.config.splash,
			planWidth: this.config.planWidth,
		};
		if (this.config.gifPath !== undefined) context.gifPath = this.config.gifPath;
		context.chafaArgs = this.config.chafaArgs;
		context.onWidth = (width) => this.requestWidth(width);
		if (this.status !== undefined) context.status = this.status;
		return context;
	}

	/** Ask the session for frames at `width`, at most once per width. */
	private requestWidth(width: number): void {
		if (this.requestedWidth === width) return;
		this.requestedWidth = width;
		// Never rebuild synchronously inside `render()`: pi is mid-layout here.
		queueMicrotask(() => this.onWidthChange?.(width));
	}

	/** One card for every layout failure: config structure or size allocation. */
	private errorCard(message: string, cols: number): string[] {
		const width = Math.max(1, Math.min(cols, Math.max(20, this.config.splash.width)));
		// Same viewport budget as `renderSplash`: a card must never push pi's editor
		// off screen. One row is reserved for the status line underneath.
		const room = Math.max(3, splashRows(this.tui.terminal?.rows ?? 40) - 1);
		const card = renderLayoutError(message, width, this.painter, room);
		return centerBlock(card, cols).map((line) => truncateToWidth(line, cols, ""));
	}

	render(width: number): string[] {
		if (!this.visible) return [];
		const cols = Math.max(1, Math.floor(Number.isFinite(width) ? width : 80));
		if (this.config.layoutError !== undefined) return this.errorCard(this.config.layoutError, cols);
		const tree = this.config.layoutTree;
		if (!tree) {
			return this.errorCard("layout: no layout tree configured (expected a chafa|layout|window node)", cols);
		}
		// `splashRows()` and the status row are applied inside `renderSplash`, so
		// the terminal height is passed raw and the renderer owns the viewport.
		return renderSplash(tree, this.renderContext(), { width: cols, height: this.tui.terminal?.rows ?? 40 });
	}
}

function normalizeFrames(
	config: BannerConfig,
	frames: Map<string, FrameSet> | FrameSet | undefined,
): Map<string, FrameSet> | undefined {
	if (!frames) return undefined;
	if (frames instanceof Map) return frames;
	return framesByKey(config.plans[0], frames);
}
