/**
 * The header component itself.
 *
 * pi calls `render(width)` synchronously on every frame, so all animation frames
 * are pre-rendered by `frames.ts` and this class only indexes into them. The
 * timer just bumps the index, invalidates, and asks pi for a redraw.
 *
 * Lifecycle: created inside the `setHeader` factory (which hands us the live
 * `tui` + `theme`), paused while the agent is streaming, disposed on
 * session shutdown / header replacement.
 */

import type { Component, Theme, TUI } from "@earendil-works/pi-coding-agent";
import {
	BANNER_MAX_WIDTH,
	BANNER_MIN_COMPACT_WIDTH,
	BANNER_MIN_STACK_WIDTH,
	formatSize,
	type BannerConfig,
} from "./config.ts";
import type { FrameSet } from "./frames.ts";
import {
	centerBlock,
	clampLines,
	compactSplash,
	infoBox,
	panel,
	resourcePanel,
	themePainter,
	twoColumn,
	type Painter,
	type ResourceSection,
} from "./layout.ts";
import type { BannerResources } from "./resources.ts";
import { maxVisibleWidth, padVisible, truncateToWidth } from "./text.ts";

/** Width of the gap between the image column and the resources panel. */
const COLUMN_GAP = 4;
/** Minimum width that still fits a readable RESOURCES panel. */
const MIN_PANEL_WIDTH = 28;
/** Info card: 3 rows + 2 borders. */
const INFO_BOX_ROWS = 5;
/** Below this many rows the header is cropped instead of shown in full. */
const MIN_CROP_ROWS = 10;

export interface BannerInit {
	config: BannerConfig;
	resources: BannerResources;
	frames?: FrameSet;
	status?: string;
}

export class Banner implements Component {
	private readonly painter: Painter;
	private config: BannerConfig;
	private resources: BannerResources;
	private frames: FrameSet | undefined;
	private status: string | undefined;
	private frameIndex = 0;
	private timer: ReturnType<typeof setInterval> | undefined;
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
		const count = this.frames?.frames.length ?? 0;
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

	// -- animation ----------------------------------------------------------

	start(): void {
		this.stopTimer();
		if (this.disposed || !this.visible || this.paused) return;
		// Static mode = one frame, zero timers, zero requestRender churn.
		if (this.frozen || this.config.static) return;
		const count = this.frames?.frames.length ?? 0;
		if (count < 2) return;
		const intervalMs = Math.max(33, Math.round(1000 / Math.max(1, this.config.fps)));
		this.timer = setInterval(() => {
			if (this.disposed || this.paused || this.frozen || !this.visible) return;
			const total = this.frames?.frames.length ?? 0;
			if (total < 2) return;
			this.frameIndex = (this.frameIndex + 1) % total;
			this.invalidate();
			this.tui.requestRender();
		}, intervalMs);
		// Never keep the process alive just to animate a splash.
		this.timer.unref?.();
	}

	stopTimer(): void {
		if (this.timer !== undefined) {
			clearInterval(this.timer);
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
	}

	invalidate(): void {
		// Nothing cached: render() is a pure composition of pre-built strings.
		// The method is required by the Component contract.
	}

	statusLine(): string {
		const frames = this.frames;
		const framePart = frames
			? `frames=${frames.frames.length}/${frames.totalFrames} (stride ${frames.stride}${frames.fromCache ? ", cached" : ""})`
			: "frames=pending";
		return `${describe(this.config)}  ${framePart}${this.frozen ? "  frozen" : ""}`;
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
		const painter = this.painter;
		const resources = this.resources;

		// Tiny terminal: no boxes, just the three facts that matter.
		if (cols < BANNER_MIN_COMPACT_WIDTH) {
			return compactSplash(cols, painter, {
				version: resources.version,
				model: resources.model,
				theme: resources.theme,
			});
		}

		const blockWidth = Math.min(Math.max(20, cols - 4), BANNER_MAX_WIDTH);
		const rawImage = this.currentFrame();
		const imageWidth = rawImage ? Math.min(blockWidth, maxVisibleWidth(rawImage)) : 0;
		const infoWidth = Math.min(Math.max(imageWidth || 40, 32), blockWidth);
		const leftWidth = Math.max(infoWidth, Math.min(imageWidth, blockWidth));

		const sections: ResourceSection[] = [
			{ title: "Context", names: resources.context },
			{ title: "Skills", names: resources.skills },
			{ title: "Themes", names: resources.themes },
			{ title: "Extensions", names: resources.extensions },
		];

		const rightWidth = blockWidth - leftWidth - COLUMN_GAP;
		const twoColumns = blockWidth >= BANNER_MIN_STACK_WIDTH && rightWidth >= MIN_PANEL_WIDTH;
		// In the stacked layout the panel is a sibling below the info card, so its
		// height must be part of the crop budget too (check the two-column branch
		// below, where the panel is padded to the left column instead).
		const stackedPanel = twoColumns ? undefined : resourcePanel("RESOURCES", sections, blockWidth, painter);

		let imageBudget: number | undefined;
		const rows = this.tui.terminal?.rows;
		if (rows && rows >= MIN_CROP_ROWS) {
			const blockOverhead = 1 + INFO_BOX_ROWS + (this.status ? 1 : 0);
			const panelOverhead = stackedPanel ? 1 + stackedPanel.length : 0;
			imageBudget = Math.max(0, rows - blockOverhead - panelOverhead);
		}
		const image = this.imageFor(blockWidth, imageBudget);

		const left: string[] = [];
		if (image) {
			for (const line of image) left.push(truncateToWidth(padVisible(line, leftWidth), leftWidth, ""));
		} else {
			left.push(...this.placeholder(leftWidth));
		}
		left.push("");
		left.push(
			...infoBox(
				"(pi) CODING AGENT",
				[
					{ label: "version", value: resources.version },
					{ label: "model", value: resources.model },
					{ label: "theme", value: resources.theme },
				],
				leftWidth,
				painter,
				{ fillTo: INFO_BOX_ROWS },
			),
		);
		if (this.status) {
			left.push(painter.fg("dim", truncateToWidth(this.status, leftWidth, "…")));
		}

		let lines: string[];
		if (twoColumns) {
			// Two columns: the panel is padded to the left column's height so the
			// outer rectangle lines up exactly.
			const right = resourcePanel("RESOURCES", sections, rightWidth, painter, left.length);
			lines = twoColumn(left, right, COLUMN_GAP, blockWidth);
		} else {
			lines = [...centerBlock(left, blockWidth), "", ...(stackedPanel ?? [])];
		}

		// Pad to the block rectangle, then center the block in the terminal.
		const padded = lines.map((line) => padVisible(line, blockWidth));
		const leftPad = Math.max(0, Math.floor((cols - blockWidth) / 2));
		const shifted = leftPad === 0 ? padded : padded.map((line) => " ".repeat(leftPad) + line);
		// Trailing spaces are harmless; enforce the width contract regardless.
		return clampLines(shifted, cols);
	}

	/**
	 * Pick and size the art. On short terminals the image is cropped from the top
	 * so the info card and panel still fit on the first screen (pi's main screen
	 * scrolls the header, not the other way around).
	 */
	private imageFor(blockWidth: number, maxRows?: number): string[] | undefined {
		const frame = this.currentFrame();
		if (!frame) return undefined;
		let lines = frame;
		if (maxRows !== undefined && lines.length > maxRows) lines = lines.slice(0, Math.max(0, maxRows));
		return lines.map((line) => truncateToWidth(line, blockWidth, ""));
	}

	/**
	 * "Building" card that reserves the art's footprint. The box sits at the top
	 * (not vertically centered) so the RESOURCES panel — whose first row is the
	 * left column's first row — stays aligned with it across the swap.
	 */
	private placeholder(width: number): string[] {
		const height = this.config.size.height;
		// Surface the reason (missing gif/chafa/ffmpeg) instead of pretending to
		// still be rendering — this card is the whole "compact text splash".
		const note = this.status ? `unavailable: ${truncateToWidth(this.status, Math.max(8, width - 12), "…")}` : "rendering chafa frames…";
		const box = panel("IMAGE", [this.painter.fg("dim", note)], width, this.painter);
		if (box.length >= height) return box.slice(0, height);
		return [...box, ...Array.from({ length: height - box.length }, () => "")];
	}
}

function describe(config: BannerConfig): string {
	return `size=${formatSize(config.size)} fps=${config.fps} stride=${config.stride} mode=${config.static ? "static" : "anim"}`;
}

export { describe as describeBannerConfig };
