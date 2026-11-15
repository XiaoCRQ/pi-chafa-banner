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
import { formatSize, type BannerConfig, type PanelField, type ResourceSectionId } from "./config.ts";
import type { FrameSet } from "./frames.ts";
import type { ImageFrameSet } from "./images.ts";
import { buildKittyLine, cropKittyRoot, encodeKittyDelete, fallbackImageId, reassignKittyImageId, replaceKittyPayload } from "./kitty.ts";
import {
	IMAGE_GAP_ROWS,
	blockWidthFor,
	compactSplash,
	cropTopRows,
	infoBox,
	panel,
	panelWidths,
	planImageBand,
	resourcePanel,
	splashRows,
	themePainter,
	twoColumn,
	wrapNames,
	type ImageBandPlan,
	type Painter,
	type ResourceSection,
} from "./layout.ts";
import type { BannerResources } from "./resources.ts";
import { isImageLine, maxVisibleWidth, padVisible, truncateToWidth, visibleWidth } from "./text.ts";

/** Info card: 3 rows + 2 borders. */
const INFO_BOX_ROWS = 5;
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
		const leftPad = Math.max(0, Math.floor((cols - blockWidth) / 2));
		const totalRows = splashRows(this.tui.terminal?.rows ?? 40);
		const body = Math.max(0, totalRows - (this.status ? 1 : 0));
		const band = this.bandLines(blockWidth, body);
		const lines = [
			...band,
			...this.lowerLines(blockWidth, Math.max(0, body - band.length)),
			...this.statusLines(blockWidth),
		];

		return lines.map((line) => {
			if (line === "") return "";
			// An image sequence owns its row: pi derives the reserved row count from
			// the raw line, so only the centering pad may precede it.
			if (isImageLine(line)) return leftPad > 0 ? " ".repeat(leftPad) + line : line;
			return truncateToWidth(" ".repeat(leftPad) + padVisible(line, blockWidth), cols, "");
		});
	}

	/**
	 * Top of the splash: one full-width band for the artwork.
	 *
	 * Both renderers produce the same shape — a single pixel line plus `rows-1`
	 * empty continuations, or chafa's character rows — so the panel block below
	 * starts on the same row either way and the two modes look identical.
	 */
	private bandLines(blockWidth: number, bodyRows: number): string[] {
		const rows =
			this.renderer === "kitty" ? this.pixelBand(blockWidth, bodyRows) : this.charBand(blockWidth, bodyRows);
		return [...rows, ...Array.from({ length: IMAGE_GAP_ROWS }, () => "")];
	}

	/** Native pixels: one sequence line, `plan.rows - 1` empty continuation rows. */
	private pixelBand(blockWidth: number, bodyRows: number): string[] {
		const terminalColumns = this.tui.terminal?.columns ?? blockWidth;
		const terminalRows = this.tui.terminal?.rows ?? 40;
		// Resize first: it may hand us a new image id, and that id must be on screen
		// in the very frame the terminal reflows.
		this.syncTerminalShape(terminalColumns, terminalRows);

		const images = this.images;
		if (!images) return this.imagePlaceholder(blockWidth);

		// Crop the source rectangle instead of dropping the picture: a short
		// terminal then shows fewer rows of real pixels, not a placeholder card.
		const plan = planImageBand({
			totalRows: bodyRows,
			statusRows: 0,
			availableColumns: blockWidth,
			lowerRows: this.config.layout.lowerRows,
			image: {
				rows: images.rows,
				columns: images.columns,
				pixelWidth: images.pixelWidth,
				pixelHeight: images.pixelHeight,
			},
		});
		if (!plan) return this.imagePlaceholder(blockWidth);

		const imgPad = Math.max(0, Math.floor((blockWidth - plan.columns) / 2));
		const rows = [(imgPad > 0 ? " ".repeat(imgPad) : "") + this.imageLine(images, plan)];
		// Continuation rows must be "" — see the class doc and AGENTS.md §3.10.
		for (let index = 1; index < plan.rows; index++) rows.push("");
		return rows;
	}

	/** Character art: chafa rows, cropped from the top when the terminal is short. */
	private charBand(blockWidth: number, bodyRows: number): string[] {
		const frame = this.currentFrame();
		if (!frame) return this.placeholder(blockWidth);
		const lower = Math.min(
			this.config.layout.lowerRows,
			Math.max(MIN_LOWER_FLOOR, bodyRows - IMAGE_GAP_ROWS - 1),
		);
		const room = Math.max(1, bodyRows - IMAGE_GAP_ROWS - lower);
		const rows = cropTopRows(frame, Math.min(frame.length, room));
		const width = Math.min(blockWidth, maxVisibleWidth(rows));
		const pad = Math.max(0, Math.floor((blockWidth - width) / 2));
		return rows.map((line) => " ".repeat(pad) + truncateToWidth(padVisible(line, width), width, ""));
	}

	/**
	 * The block under the picture: info card on the left, RESOURCES on the right,
	 * equal widths, equal heights, one shared divider column.
	 */
	private lowerLines(blockWidth: number, budget: number): string[] {
		const layout = this.config.layout;
		const painter = this.painter;
		const infoEnabled = this.config.panels.info.enabled;
		const resourcesEnabled = this.config.panels.resources.enabled;
		if (!infoEnabled && !resourcesEnabled) return [];

		const infoRows = this.infoRows();
		const sections = this.sections();
		const stacked = blockWidth < layout.twoColumnMinWidth;
		const widths = panelWidths(blockWidth, layout.gap, this.config.panels.resources.width);
		const options = { maxLinesPerSection: this.config.panels.resources.maxLinesPerSection };

		// Both boxes share one height so their bottom borders line up; content that
		// would not fit grows the box up to the space the document body allows.
		const wanted = this.config.panels.resources.height;
		const contentRows = sections.reduce((sum, section) => {
			const lines =
				section.names.length === 0 ? 1 : wrapNames(section.names, Math.max(4, widths.right - 4)).length;
			return sum + Math.min(lines, options.maxLinesPerSection);
		}, 2);
		const height = Math.max(
			3,
			Math.min(
				Math.max(budget, 3),
				Math.max(layout.lowerRows, typeof wanted === "number" ? wanted : 0, contentRows),
			),
		);

		if (!resourcesEnabled) {
			return infoEnabled ? infoBox("(pi) CODING AGENT", infoRows, blockWidth, painter, { fillTo: height }) : [];
		}
		if (!infoEnabled) {
			return resourcePanel("RESOURCES", sections, blockWidth, painter, height, options);
		}
		if (stacked) {
			const panelRows = Math.max(5, Math.min(height, budget - INFO_BOX_ROWS - 1));
			return [
				...infoBox("(pi) CODING AGENT", infoRows, blockWidth, painter, { fillTo: INFO_BOX_ROWS }),
				"",
				...resourcePanel("RESOURCES", sections, blockWidth, painter, panelRows, options),
			];
		}

		const left = infoBox("(pi) CODING AGENT", infoRows, widths.left, painter, { fillTo: height });
		const right = resourcePanel("RESOURCES", sections, widths.right, painter, height, options);
		return twoColumn(left, right, layout.gap, blockWidth);
	}

	/** Facts shown in the coding-agent box, in config order. */
	private infoRows(): Array<{ label: string; value: string }> {
		const resources = this.resources;
		const values: Record<PanelField, string> = {
			version: resources.version,
			model: resources.model,
			theme: resources.theme,
			gif: this.config.gifPath ?? "(bundled)",
			frames: this.frames ? `${this.frames.frames.length}/${this.frames.totalFrames}` : "pending",
			renderer: this.renderer,
		};
		return this.config.panels.info.fields.map((field) => ({ label: field, value: values[field] ?? "" }));
	}

	/** Resource groups the RESOURCES box lists, in config order. */
	private sections(): ResourceSection[] {
		const resources = this.resources;
		const all: Record<ResourceSectionId, ResourceSection> = {
			context: { title: "Context", names: resources.context },
			skills: { title: "Skills", names: resources.skills },
			themes: { title: "Themes", names: resources.themes },
			extensions: { title: "Extensions", names: resources.extensions },
		};
		return this.config.panels.resources.sections.map((id) => all[id]).filter(Boolean);
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
