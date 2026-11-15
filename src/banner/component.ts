/**
 * The header component itself.
 *
 * pi calls `render(width)` synchronously on every frame, so all animation frames
 * are pre-rendered by `frames.ts` and this class only indexes into them. The
 * timer just bumps the index, invalidates, and asks pi for a redraw.
 *
 * Layout: the artwork sits at the top left, the info card right beneath it, and
 * the RESOURCES panel runs down the right-hand side. When the terminal is too
 * narrow for two columns the right panel drops below the left block, and below
 * `layout.compactMinWidth` everything collapses into three plain lines.
 *
 * Lifecycle: created inside the `setHeader` factory (which hands us the live
 * `tui` + `theme`), paused while the agent is streaming, disposed on
 * session shutdown / header replacement.
 */

import type { Component, Theme, TUI } from "@earendil-works/pi-coding-agent";
import type { BannerConfig } from "../config.ts";
import type { FrameSet } from "../frames.ts";
import { DEFAULT_FRAME_DELAY_MS } from "../pipeline/timing.ts";
import { buildStatusLine, charPlaceholder, describeConfig, infoRows as infoRowsFor, sections as sectionsFor, statusLines as statusLinesFor } from "./panels.ts";
import {
	blockWidthFor,
	centerBlock,
	compactSplash,
	infoBox,
	resourcePanel,
	splashRows,
	themePainter,
	twoColumn,
	type Painter,
	type ResourceSection,
} from "../layout.ts";
import type { BannerResources } from "../resources.ts";
import { padVisible, truncateToWidth, visibleWidth, maxVisibleWidth } from "../text.ts";

/** Info card: 3 content rows + 2 borders. */
const INFO_BOX_ROWS = 5;
/** Width of the gap between the two columns. */
const COLUMN_GAP_MIN = 2;

export interface BannerInit {
	config: BannerConfig;
	resources: BannerResources;
	frames?: FrameSet;
	status?: string;
}

export class Banner implements Component {
	/** Floor between two frames: below this the redraw churn is not worth it. */
	private static readonly MIN_FRAME_MS = 20;

	private readonly painter: Painter;
	private config: BannerConfig;
	private resources: BannerResources;
	private frames: FrameSet | undefined;
	private status: string | undefined;
	private frameIndex = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private visible: boolean;
	private frozen: boolean;
	private paused = false;
	private disposed = false;

	constructor(
		private readonly tui: TUI,
		theme: Theme,
		init: BannerInit,
	) {
		this.painter = themePainter(theme);
		this.config = init.config;
		this.resources = init.resources;
		this.frames = init.frames;
		this.status = init.status;
		this.visible = init.config.enabled;
		this.frozen = init.config.static;
	}

	// -- data ---------------------------------------------------------------

	setFrames(frames: FrameSet | undefined): void {
		this.frames = frames;
		const count = frames?.frames.length ?? 0;
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

	private frameCount(): number {
		return this.frames?.frames.length ?? 0;
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
		const delay = this.frames?.delays[this.frameIndex];
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
		return buildStatusLine(this.config, this.frames, this.frozen);
	}

	// -- rendering ----------------------------------------------------------

	private currentFrame(): string[] | undefined {
		const frames = this.frames;
		if (!frames || frames.frames.length === 0) return undefined;
		const index = Math.min(this.frameIndex, frames.frames.length - 1);
		return frames.frames[index];
	}

	render(width: number): string[] {
		if (!this.visible) return [];
		const cols = Math.max(1, Math.floor(width));
		const layout = this.config.layout;
		// Too narrow for boxes: three plain lines, no picture.
		if (cols < layout.compactMinWidth) {
			return compactSplash(cols, this.painter, {
				version: this.resources.version,
				model: this.resources.model,
				theme: this.resources.theme,
			});
		}

		const blockWidth = blockWidthFor(cols, layout);
		const frame = this.currentFrame();
		const imageWidth = frame ? Math.min(blockWidth, maxVisibleWidth(frame)) : 0;
		const infoEnabled = this.config.panels.info.enabled;
		const resourcesEnabled = this.config.panels.resources.enabled;

		// The artwork sets the width of the left column; the info card never
		// shrinks below 32 columns so its labels stay readable.
		const leftWidth = Math.max(
			Math.min(Math.max(imageWidth || 40, 32), blockWidth),
			Math.min(imageWidth, blockWidth),
		);
		const rightWidth = blockWidth - leftWidth - this.gap();
		const twoColumns =
			infoEnabled && resourcesEnabled && blockWidth >= layout.twoColumnMinWidth && rightWidth >= 28;

		const left = this.leftColumn(blockWidth, leftWidth, frame, twoColumns);
		const right = resourcesEnabled
			? resourcePanel("RESOURCES", this.sections(), twoColumns ? rightWidth : blockWidth, this.painter,
					twoColumns ? left.length : this.stackedHeight(), {
						maxLinesPerSection: this.config.panels.resources.maxLinesPerSection,
					})
			: [];

		const lines = twoColumns
			? twoColumn(left, right, this.gap(), blockWidth)
			: [...centerBlock(left, blockWidth), ...(right.length > 0 ? ["", ...right] : [])];
		const status = this.status ? [this.painter.fg("dim", truncateToWidth(this.status, blockWidth, "…"))] : [];
		const padded = [...lines, ...status].map((line) => (line === "" ? "" : padVisible(line, blockWidth)));
		if (padded.every((line) => line === "")) return [];
		return centerBlock(padded, cols).map((line) => truncateToWidth(line, cols, ""));
	}

	/**
	 * Left column: the artwork, a blank line, then the info card.
	 *
	 * The frame is clipped to whatever the document body has left after the info
	 * card and the status line (a text banner that overflows pushes pi's editor
	 * around). `layout.lowerRows` is the floor for the whole block.
	 */
	private leftColumn(blockWidth: number, leftWidth: number, frame: string[] | undefined, twoColumns: boolean): string[] {
		const rows = frame
			? this.cropFrame(frame, leftWidth, this.imageBudget(twoColumns))
			: this.placeholder(leftWidth);
		const out = [...rows];
		if (this.config.panels.info.enabled) {
			out.push("", ...infoBox("(pi) CODING AGENT", this.infoRows(), leftWidth, this.painter, { fillTo: INFO_BOX_ROWS }));
		}
		return out;
	}

	/** Rows the artwork may use: body height minus the info card, gap and status. */
	private imageBudget(twoColumns: boolean): number {
		const totalRows = splashRows(this.tui.terminal?.rows ?? 40);
		const overhead = (this.config.panels.info.enabled ? INFO_BOX_ROWS + 1 : 0) + (this.status ? 1 : 0);
		const stacked = twoColumns ? 0 : this.stackedHeight() + 1;
		return Math.max(1, totalRows - overhead - stacked);
	}

	/** Height of the RESOURCES panel when it sits below the left block. */
	private stackedHeight(): number {
		const wanted = this.config.panels.resources.height;
		return Math.max(this.config.layout.lowerRows, typeof wanted === "number" ? wanted : 0);
	}

	/** Clip chafa's frame to `rows` lines starting from the top (faces live there). */
	private cropFrame(frame: readonly string[], width: number, rows: number): string[] {
		const out: string[] = [];
		for (const line of frame.slice(0, Math.max(1, rows))) {
			const trimmed = truncateToWidth(line, width, "");
			const pad = Math.max(0, Math.floor((width - visibleWidth(trimmed)) / 2));
			out.push(" ".repeat(pad) + trimmed);
		}
		return out;
	}

	/** "No picture yet": a five-row card that keeps the block size stable. */
	private placeholder(width: number): string[] {
		return charPlaceholder(this.painter, this.status, width, Math.min(this.config.size.height, 5));
	}

	private gap(): number {
		return Math.max(COLUMN_GAP_MIN, this.config.layout.gap);
	}

	private infoRows(): Array<{ label: string; value: string }> {
		return infoRowsFor(this.config, this.resources, this.frames);
	}

	private sections(): ResourceSection[] {
		return sectionsFor(this.config, this.resources);
	}
}

export { describeConfig as describeBannerConfig } from "./panels.ts";