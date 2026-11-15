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
import type { ImageFrameSet } from "./images.ts";
import { buildKittyLine, cropKittyRoot, encodeKittyDelete, fallbackImageId, reassignKittyImageId, replaceKittyPayload } from "./kitty.ts";
import {
	IMAGE_GAP_ROWS,
	MAX_LOWER_ROWS,
	MIN_LOWER_ROWS,
	blockWidthFor,
	centerBlock,
	clampLines,
	compactSplash,
	infoBox,
	panel,
	planImageBand,
	resourcePanel,
	splashRows,
	themePainter,
	twoColumn,
	type ImageBandPlan,
	type Painter,
	type ResourceSection,
} from "./layout.ts";
import type { BannerResources } from "./resources.ts";
import { isImageLine, maxVisibleWidth, padVisible, truncateToWidth, visibleWidth } from "./text.ts";

/** Width of the gap between the image column and the resources panel. */
const COLUMN_GAP = 4;
/** Minimum width that still fits a readable RESOURCES panel. */
const MIN_PANEL_WIDTH = 28;
/** Info card: 3 rows + 2 borders. */
const INFO_BOX_ROWS = 5;
/** Below this many rows the header is cropped instead of shown in full. */
const MIN_CROP_ROWS = 10;
/** Lines the image-mode "no picture yet" card occupies (never height-dependent). */
const IMAGE_PLACEHOLDER_ROWS = 5;
/** Floor for the info/panel block when the terminal cannot fit its ideal size. */
const MIN_LOWER_FLOOR = 4;

export interface BannerInit {
	config: BannerConfig;
	resources: BannerResources;
	frames?: FrameSet;
	images?: ImageFrameSet;
	/** `kitty` switches `render()` to the image band; `chars` is the default. */
	renderer?: "chars" | "kitty";
	status?: string;
}

export class Banner implements Component {
	private readonly painter: Painter;
	private config: BannerConfig;
	private resources: BannerResources;
	private frames: FrameSet | undefined;
	private images: ImageFrameSet | undefined;
	private renderer: "chars" | "kitty";
	private status: string | undefined;
	private frameIndex = 0;
	/** `anim` mode: the single composed line, rebuilt only when it can change. */
	private animLine: string | undefined;
	private animLineKey = "";
	/** `frames` mode: one root sequence per frame, built lazily on first render. */
	private frameLines: string[] | undefined;
	private frameLinesKey = "";
	/** Short terminal: the same line with a cropped source rect (`x/y/w/h`). */
	private cropLine: string | undefined;
	private cropLineKey = "";
	/** Last `${columns}x${rows}` seen by `render()`; a change forces a re-upload. */
	private shapeKey = "";
	/** Image ids to delete once the current frame has been written. */
	private pendingDeletes: number[] = [];
	private timer: ReturnType<typeof setInterval> | undefined;
	/** `PI_BANNER_ANIM_SECONDS`: stop the animation after a while. */
	private freezeTimer: ReturnType<typeof setTimeout> | undefined;
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
		this.images = init.images;
		this.renderer = init.renderer ?? "chars";
		this.status = init.status;
		this.visible = init.config.enabled;
		this.frozen = init.config.static;
		this.preloadImageLines();
	}

	// -- data ---------------------------------------------------------------

	setFrames(frames: FrameSet | undefined): void {
		this.frames = frames;
		const count = frames?.frames.length ?? 0;
		if (count === 0) this.frameIndex = 0;
		else this.frameIndex %= count;
		this.start();
	}

	/**
	 * Install (or drop) the native image. Dropping it keeps the renderer at kitty
	 * so `render()` degrades to the placeholder card instead of switching layouts
	 * mid-session.
	 */
	setImages(images: ImageFrameSet | undefined): void {
		const previous = this.images;
		this.images = images;
		this.resetImageCaches();
		// A rebuild allocates a new id; free the old picture so kitty does not keep
		// a stranded copy (and a stranded animation) alive.
		if (previous && previous.imageId !== images?.imageId) this.releaseImageId(previous.imageId);
		const count = images?.frames.length ?? 0;
		if (count === 0) this.frameIndex = 0;
		else this.frameIndex %= count;
		this.start();
		this.preloadImageLines();
		this.invalidate();
	}

	/**
	 * Compose the multi-megabyte image line(s) here, not inside `render()`.
	 *
	 * `render()` must stay a cheap synchronous composition (pi calls it on every
	 * frame); building ~2 MB of base64 chunks there costs a single main-thread
	 * concat per first paint. This runs right after the async image build, where
	 * nobody is waiting on a frame.
	 */
	private preloadImageLines(): void {
		const images = this.images;
		if (!images || this.renderer !== "kitty" || images.frames.length === 0) return;
		try {
			this.imageLine(images);
		} catch {
			// Fall back to building it lazily on the first render.
		}
	}

	private resetImageCaches(): void {
		this.animLine = undefined;
		this.animLineKey = "";
		this.frameLines = undefined;
		this.frameLinesKey = "";
		this.cropLine = undefined;
		this.cropLineKey = "";
	}

	// -- terminal lifecycle --------------------------------------------------

	/**
	 * A resize makes the terminal reflow — and kitty may silently drop — the
	 * placement, while pi's alt-screen path can substitute `a=p` (no payload) for
	 * our root frame as long as it believes the id was already uploaded.
	 *
	 * Retransmitting under a fresh id invalidates that cache: pi sees an unknown
	 * id and writes the full `a=T` sequence again. The old id is freed afterwards
	 * (deferred, never inside `render()`).
	 */
	private syncTerminalShape(columns: number, rows: number): void {
		const key = `${columns}x${rows}`;
		if (this.shapeKey === key) return;
		const first = this.shapeKey === "";
		this.shapeKey = key;
		if (first || this.renderer !== "kitty") return;
		const images = this.images;
		if (!images) return;
		const imageId = fallbackImageId();
		this.images = { ...images, imageId, sequence: reassignKittyImageId(images.sequence, imageId) };
		this.resetImageCaches();
		this.releaseImageId(images.imageId);
		this.preloadImageLines();
	}

	/** Write a kitty control sequence to the terminal, if the host exposes it. */
	private writeToTerminal(data: string): void {
		const terminal = this.tui.terminal;
		const write = terminal?.write;
		if (typeof write !== "function") return;
		try {
			write.call(terminal, data);
		} catch {
			// Terminal already torn down; the placement dies with it.
		}
	}

	/**
	 * Free one image id (`a=d,d=I`). Deferred to the next tick by default so the
	 * bytes never interleave with a frame pi is still composing; `now` is used on
	 * the dispose path, where the process may exit before a timer fires.
	 */
	releaseImageId(imageId: number, now = false): void {
		if (this.renderer !== "kitty") return;
		if (now) {
			this.writeToTerminal(encodeKittyDelete(imageId));
			return;
		}
		this.pendingDeletes.push(imageId);
		const timer = setTimeout(() => {
			const ids = this.pendingDeletes;
			this.pendingDeletes = [];
			for (const id of ids) this.writeToTerminal(encodeKittyDelete(id));
		}, 0);
		timer.unref?.();
	}

	/**
	 * Drop the picture from the terminal. Called before the header goes away:
	 * without this the placement survives `/splash off`, session shutdown and
	 * process exit, leaving a picture that keeps animating behind the prompt.
	 */
	releaseImage(): void {
		const images = this.images;
		if (!images) return;
		this.releaseImageId(images.imageId, true);
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
		this.resetImageCaches();
		this.frozen = config.static || this.frozen;
		this.visible = config.enabled;
		if (!this.visible) this.stopTimer();
		this.preloadImageLines();
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
		this.animLine = undefined;
		this.animLineKey = "";
		if (this.frozen) this.stopTimer();
		else this.start();
		this.invalidate();
		return this.frozen;
	}

	isFrozen(): boolean {
		return this.frozen;
	}

	/** Frames `render()` can show; kitty `anim` mode is one line by definition. */
	private frameCount(): number {
		if (this.renderer === "kitty" && this.images) {
			return this.config.kittyMode === "frames" ? this.images.frames.length : 1;
		}
		return this.frames?.frames.length ?? 0;
	}

	// -- animation ----------------------------------------------------------

	start(): void {
		this.stopTimer();
		if (this.disposed || !this.visible || this.paused) return;
		// Static mode = one frame, zero timers, zero requestRender churn.
		if (this.frozen || this.config.static) return;
		this.scheduleAutoFreeze();
		if (this.frameCount() < 2) return;
		const intervalMs = Math.max(33, Math.round(1000 / Math.max(1, this.config.fps)));
		this.timer = setInterval(() => {
			if (this.disposed || this.paused || this.frozen || !this.visible) return;
			const total = this.frameCount();
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
		if (this.freezeTimer !== undefined) {
			clearTimeout(this.freezeTimer);
			this.freezeTimer = undefined;
		}
	}

	/**
	 * `PI_BANNER_ANIM_SECONDS > 0`: after N seconds the image becomes a still.
	 * In kitty `anim` mode this rewrites the line (root frame only), which pi
	 * detects as a change and retransmits — the documented cost of the knob.
	 */
	private scheduleAutoFreeze(): void {
		const seconds = this.config.animSeconds;
		if (!(seconds > 0)) return;
		if (this.renderer !== "kitty" || !this.images) return;
		const ms = Math.min(seconds * 1000, 2 ** 31 - 1);
		this.freezeTimer = setTimeout(() => {
			this.freezeTimer = undefined;
			this.frozen = true;
			this.animLine = undefined;
			this.animLineKey = "";
			this.stopTimer();
			this.invalidate();
			this.tui.requestRender();
		}, ms);
		this.freezeTimer.unref?.();
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
		// Free the placement first: this is the last moment the terminal is ours.
		this.releaseImage();
		// Drop the multi-megabyte base64/sequence strings.
		this.resetImageCaches();
		this.images = undefined;
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
		return `${describe(this.config)}  ${framePart}${this.frozen ? "  frozen" : ""} mode=${this.renderer}`;
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
		// Too narrow for boxes: the same three lines either way, no image band.
		if (cols < BANNER_MIN_COMPACT_WIDTH) {
			return compactSplash(cols, this.painter, {
				version: this.resources.version,
				model: this.resources.model,
				theme: this.resources.theme,
			});
		}
		if (this.renderer === "kitty") return this.renderImage(cols, blockWidthFor(cols));
		return this.renderChars(width);
	}

	/**
	 * Character-cell rendering (chafa frames). Kept byte-for-byte identical to
	 * the original single-path implementation: it is the regression baseline and
	 * the fallback for every terminal without the kitty protocol.
	 */
	private renderChars(width: number): string[] {
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
			// Deliberately *not* `CHROME_ROWS` here: characters are ordinary document
			// rows, so an over-tall splash simply scrolls with the conversation (the
			// pre-v1.1 behaviour, kept byte-identical). Only the native image band
			// must fit the viewport — see `renderImage()`.
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

	// -- native image rendering --------------------------------------------

	/**
	 * Split layout: the picture owns a full-width band at the top, everything
	 * else stacks underneath.
	 *
	 * This is not cosmetic. pi's `getKittyImageReservedRows` stops counting at
	 * the first following line with `visibleWidth > 0` (a single space counts),
	 * so the `rows-1` lines after the sequence must be the exact empty string,
	 * and nothing may sit beside the image in the same row.
	 */
	private renderImage(cols: number, blockWidth: number): string[] {
		const terminalColumns = this.tui.terminal?.columns ?? cols;
		const terminalRows = this.tui.terminal?.rows ?? 40;
		// Resize first: it may hand us a new image id, and that id must be on screen
		// in the very frame the terminal reflows.
		this.syncTerminalShape(terminalColumns, terminalRows);
		const images = this.images;
		// Only the document body is ours; see `CHROME_ROWS` in layout.ts.
		const totalRows = splashRows(terminalRows);
		const statusRows = this.status ? 1 : 0;
		const leftPad = Math.max(0, Math.floor((cols - blockWidth) / 2));
		const out: string[] = [];

		// Crop the source rectangle instead of dropping the picture: a short
		// terminal then shows fewer rows of real pixels, not a placeholder card.
		const plan = images
			? planImageBand({
					totalRows,
					statusRows,
					availableColumns: Math.max(0, Math.min(blockWidth, cols - 2 * leftPad)),
					image: {
						rows: images.rows,
						columns: images.columns,
						pixelWidth: images.pixelWidth,
						pixelHeight: images.pixelHeight,
					},
				})
			: undefined;

		if (images && plan) {
			const imgPad = Math.max(0, Math.floor((blockWidth - plan.columns) / 2));
			// The only place a line may start with spaces and hold an escape.
			out.push((imgPad > 0 ? " ".repeat(imgPad) : "") + this.imageLine(images, plan));
			// Continuation rows must be "" — see the doc comment above.
			for (let index = 1; index < plan.rows; index++) out.push("");
			for (let index = 0; index < IMAGE_GAP_ROWS; index++) out.push("");
		} else {
			out.push(...this.imagePlaceholder(blockWidth), "");
		}

		const room = Math.max(0, totalRows - statusRows - out.length);
		// Below the ideal height keep whatever rows exist (never grow the block
		// past the terminal, that is what makes pi scroll the whole header away).
		const budget =
			room >= MIN_LOWER_ROWS ? Math.min(room, MAX_LOWER_ROWS) : Math.max(1, Math.min(MIN_LOWER_FLOOR, room));
		out.push(...this.renderLower(blockWidth, budget));
		if (this.status) out.push(...this.statusLines(blockWidth));

		return out.map((line) => {
			if (line === "") return "";
			if (isImageLine(line)) return leftPad > 0 ? " ".repeat(leftPad) + line : line;
			return truncateToWidth(" ".repeat(leftPad) + padVisible(line, blockWidth), cols, "");
		});
	}

	/** Info card + RESOURCES panel, on the same rows in both layouts. */
	private renderLower(blockWidth: number, budget: number): string[] {
		const painter = this.painter;
		const resources = this.resources;
		const sections: ResourceSection[] = [
			{ title: "Context", names: resources.context },
			{ title: "Skills", names: resources.skills },
			{ title: "Themes", names: resources.themes },
			{ title: "Extensions", names: resources.extensions },
		];
		const infoRows = [
			{ label: "version", value: resources.version },
			{ label: "model", value: resources.model },
			{ label: "theme", value: resources.theme },
		];

		if (blockWidth >= BANNER_MIN_STACK_WIDTH && budget >= MIN_LOWER_ROWS) {
			const infoWidth = Math.min(
				Math.max(Math.round(blockWidth * 0.38), 32),
				blockWidth - COLUMN_GAP - MIN_PANEL_WIDTH,
			);
			const rightWidth = blockWidth - infoWidth - COLUMN_GAP;
			const height = Math.min(budget, MAX_LOWER_ROWS);
			const left = infoBox("(pi) CODING AGENT", infoRows, infoWidth, painter, { fillTo: height });
			const right = resourcePanel("RESOURCES", sections, rightWidth, painter, height);
			return twoColumn(left, right, COLUMN_GAP, blockWidth);
		}

		// Anything below INFO_BOX_ROWS + gap + MIN_PANEL (11 rows) cannot show both
		// boxes: keep the info card alone rather than spilling past the terminal.
		if (budget < MIN_LOWER_ROWS) {
			return infoBox("(pi) CODING AGENT", infoRows, blockWidth, painter, {
				fillTo: Math.max(3, Math.min(budget, INFO_BOX_ROWS)),
			});
		}

		const lines = infoBox("(pi) CODING AGENT", infoRows, blockWidth, painter, { fillTo: INFO_BOX_ROWS });
		lines.push("");
		const panelRows = Math.max(5, Math.min(budget - INFO_BOX_ROWS - 1, MAX_LOWER_ROWS));
		lines.push(...resourcePanel("RESOURCES", sections, blockWidth, painter, panelRows));
		return lines;
	}

	/** One status line, kept as short as the block allows. */
	private statusLines(blockWidth: number): string[] {
		const status = this.status;
		if (!status) return [];
		return [this.painter.fg("dim", truncateToWidth(status, blockWidth, "…"))];
	}

	/**
	 * The line the terminal draws the picture on.
	 *
	 * `anim`: one constant string — the terminal loops the frames itself, so pi
	 * sees no diff and never re-renders the document.
	 * `frames`: one root sequence per frame, swapped by the timer (escape hatch
	 * for terminals that ignore `a=f`).
	 */
	private imageLine(images: ImageFrameSet, plan?: ImageBandPlan): string {
		const animate = !this.frozen && !this.config.static;
		const base = this.baseImageLine(images, animate);
		if (!plan || plan.whole) return base;
		const key = `${images.imageId}|${animate}|${this.frameIndex}|${plan.rows}x${plan.columns}@${plan.sourceX},${plan.sourceY},${plan.sourceWidth}x${plan.sourceHeight}`;
		if (this.cropLine === undefined || this.cropLineKey !== key) {
			this.cropLine = cropKittyRoot(base, plan);
			this.cropLineKey = key;
		}
		return this.cropLine;
	}

	/** The uncropped line: the whole picture at the grid the pipeline chose. */
	private baseImageLine(images: ImageFrameSet, animate: boolean): string {
		if (animate && this.config.kittyMode === "frames") {
			// Root sequences are ~100 KB each: build them once per image set.
			const frameKey = String(images.imageId);
			if (!this.frameLines || this.frameLinesKey !== frameKey) {
				this.frameLines = images.frames.map((frame, index) =>
					index === 0 ? images.sequence : replaceKittyPayload(images.sequence, frame.base64),
				);
				this.frameLinesKey = frameKey;
			}
			return this.frameLines[Math.min(this.frameIndex, this.frameLines.length - 1)] ?? images.sequence;
		}
		const key = `${images.imageId}|${animate}`;
		if (this.animLine === undefined || this.animLineKey !== key) {
			this.animLine = buildKittyLine({ images, animate, loopForever: true });
			this.animLineKey = key;
		}
		return this.animLine;
	}

	/**
	 * Image-mode placeholder: five rows, always, so a failed build cannot push
	 * the info card off a short terminal the way the old 22-row card did.
	 */
	private imagePlaceholder(width: number): string[] {
		const note = this.status
			? `unavailable: ${truncateToWidth(this.status, Math.max(8, width - 16), "…")}`
			: "rendering image band…";
		return panel("IMAGE", [this.painter.fg("dim", note)], width, this.painter, {
			fillTo: IMAGE_PLACEHOLDER_ROWS,
		});
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
