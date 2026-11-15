/**
 * kitty graphics protocol encoding — the pure, I/O-free half of native image
 * rendering.
 *
 * Two rules dominate this file:
 *
 * 1. **Never hand-roll the root frame.** pi-tui's `renderImage()` is the only
 *    supported way to turn a PNG into a `\x1b_G` sequence: passing `imageId`
 *    registers cell metadata that pi's renderer uses for cropping and for
 *    re-placing images on the alternate screen, and `moveCursor: false` emits
 *    `C=1`, which is what lets us put the image on a single line and reserve
 *    the cell rows below it ourselves.
 * 2. **`q=2` everywhere.** Without it, kitty writes `OK`/`ENOENT` responses
 *    back to the tty, which pi's stdin parser happily treats as key presses.
 *
 * The `encode*` helpers below are byte-compatible with pi-tui's `encodeKitty`
 * so tests and the (pi-tui-less) preview tool can exercise the exact wire
 * format.
 */

import type { CellDimensions, ImageDimensions } from "@earendil-works/pi-tui";

/**
 * The slice of pi-tui this extension calls. Declared structurally (instead of
 * re-exporting the ambient module type) so the dynamic import result can be
 * checked for the two functions that really matter at runtime.
 */
export type TuiKittyModule = {
	renderImage: (
		base64Data: string,
		dimensions: ImageDimensions,
		options?: {
			maxWidthCells?: number;
			maxHeightCells?: number;
			imageId?: number;
			moveCursor?: boolean;
		},
	) => { sequence: string; columns: number; rows: number; imageId?: number } | null;
	getCapabilities: () => { images: "kitty" | "iterm2" | null; trueColor: boolean };
	getCellDimensions: () => CellDimensions;
	allocateImageId: () => number;
};

/** kitty's hard limit on a single graphics payload chunk. */
export const KITTY_CHUNK_SIZE = 4096;
export const DEFAULT_CELL: CellDimensions = { widthPx: 9, heightPx: 18 };

let modulePromise: Promise<TuiKittyModule | undefined> | undefined;

/**
 * Resolve pi's own pi-tui instance and cache the result.
 *
 * Returns `undefined` when the specifier cannot be resolved (unit tests, the
 * preview script, exotic hosts). Callers must then fall back to the local
 * encoder — never to "no image at all".
 */
export async function loadKittyModule(): Promise<TuiKittyModule | undefined> {
	if (!modulePromise) {
		modulePromise = (async () => {
			try {
				const mod = (await import("@earendil-works/pi-tui")) as Partial<TuiKittyModule> | undefined;
				if (!mod || typeof mod.renderImage !== "function" || typeof mod.getCapabilities !== "function") {
					return undefined;
				}
				return mod as TuiKittyModule;
			} catch {
				return undefined;
			}
		})();
	}
	return modulePromise;
}

/** Detected inline-image protocol, or `null` when the terminal has none. */
export async function kittyCapabilities(): Promise<"kitty" | "iterm2" | null> {
	const module = await loadKittyModule();
	if (!module) return null;
	try {
		return module.getCapabilities().images ?? null;
	} catch {
		return null;
	}
}

/** Terminal cell size in pixels (defaults to 9x18 when unknown). */
export async function kittyCellDimensions(): Promise<CellDimensions> {
	const module = await loadKittyModule();
	if (!module) return { ...DEFAULT_CELL };
	try {
		const cell = module.getCellDimensions();
		const widthPx = Math.max(1, Math.floor(cell?.widthPx ?? DEFAULT_CELL.widthPx));
		const heightPx = Math.max(1, Math.floor(cell?.heightPx ?? DEFAULT_CELL.heightPx));
		return { widthPx, heightPx };
	} catch {
		return { ...DEFAULT_CELL };
	}
}

/**
 * A kitty image id, unique within this process. pi-tui uses random ids so that
 * separate module instances cannot collide; mirror that when it is unavailable.
 */
export async function allocateImageId(): Promise<number> {
	const module = await loadKittyModule();
	try {
		const id = module?.allocateImageId();
		if (typeof id === "number" && Number.isInteger(id) && id > 0) return id;
	} catch {
		// fall through
	}
	return fallbackImageId();
}

export function fallbackImageId(): number {
	return Math.floor(Math.random() * 0xfffffffe) + 1;
}

/** Split a base64 payload into kitty graphics chunks (single chunk when small). */
export function encodeKittyChunked(base64: string, headParams: string, chunkParams: string): string {
	if (base64.length <= KITTY_CHUNK_SIZE) return `\x1b_G${headParams};${base64}\x1b\\`;
	const cont = chunkParams ? `${chunkParams},` : "";
	let out = "";
	let offset = 0;
	let first = true;
	while (offset < base64.length) {
		const end = Math.min(offset + KITTY_CHUNK_SIZE, base64.length);
		const chunk = base64.slice(offset, end);
		const isLast = end >= base64.length;
		if (first) {
			out += `\x1b_G${headParams},m=1;${chunk}\x1b\\`;
			first = false;
		} else if (isLast) {
			out += `\x1b_G${cont}m=0;${chunk}\x1b\\`;
		} else {
			out += `\x1b_G${cont}m=1;${chunk}\x1b\\`;
		}
		offset = end;
	}
	return out;
}

/**
 * Cell grid for an image, mirroring pi-tui's `calculateImageCellSize` (with the
 * aspect-ratio optimisation kitty gets). Used only when pi-tui cannot be
 * resolved; otherwise `renderImage()` tells us the real grid.
 */
export function calculateImageCells(
	image: ImageDimensions,
	cell: CellDimensions = DEFAULT_CELL,
	maxColumns = 80,
	maxRows?: number,
): { columns: number; rows: number } {
	const maxWidth = Math.max(1, Math.floor(maxColumns));
	const maxHeight = maxRows === undefined ? undefined : Math.max(1, Math.floor(maxRows));
	const widthPx = Math.max(1, image.widthPx);
	const heightPx = Math.max(1, image.heightPx);
	const widthScale = (maxWidth * cell.widthPx) / widthPx;
	const heightScale = maxHeight === undefined ? widthScale : (maxHeight * cell.heightPx) / heightPx;
	const scale = Math.min(widthScale, heightScale);
	let columns = Math.max(1, Math.min(maxWidth, Math.ceil((widthPx * scale) / cell.widthPx)));
	let rows = Math.max(1, Math.ceil((heightPx * scale) / cell.heightPx));
	if (maxHeight !== undefined) rows = Math.min(maxHeight, rows);
	const lessDistorted = (upper: number, ideal: number): number => {
		if (upper <= 1) return upper;
		const lower = upper - 1;
		const upperDistortion = Math.max(upper / ideal, ideal / upper);
		const lowerDistortion = Math.max(lower / ideal, ideal / lower);
		return lowerDistortion < upperDistortion ? lower : upper;
	};
	if (widthScale <= heightScale) {
		const idealRows = (columns * cell.widthPx * heightPx) / (widthPx * cell.heightPx);
		rows = lessDistorted(rows, idealRows);
	} else {
		const idealColumns = (rows * cell.heightPx * widthPx) / (heightPx * cell.widthPx);
		columns = lessDistorted(columns, idealColumns);
	}
	return { columns, rows };
}

/** Local equivalent of pi-tui's `encodeKitty` for the root frame. */
export function encodeKittyStub(
	base64: string,
	options: { columns: number; rows: number; imageId: number },
): { sequence: string; columns: number; rows: number } {
	const params = ["a=T", "f=100", "q=2", "C=1", `c=${options.columns}`, `r=${options.rows}`, `i=${options.imageId}`];
	return {
		sequence: encodeKittyChunked(base64, params.join(","), ""),
		columns: options.columns,
		rows: options.rows,
	};
}

export interface KittyRootResult {
	sequence: string;
	columns: number;
	rows: number;
	imageId: number;
}

/**
 * Root frame for a PNG, via pi-tui when available.
 *
 * `moveCursor: false` => `C=1`: the terminal leaves the cursor in place, so the
 * caller must emit `rows - 1` strictly empty lines (pi reserves those rows).
 */
export async function renderKittyRoot(
	base64: string,
	dimensions: ImageDimensions,
	options: { maxColumns: number; maxRows: number; imageId: number },
): Promise<KittyRootResult> {
	const module = await loadKittyModule();
	if (module) {
		try {
			const result = module.renderImage(
				base64,
				dimensions,
				{
					maxWidthCells: options.maxColumns,
					maxHeightCells: options.maxRows,
					imageId: options.imageId,
					moveCursor: false,
				},
			);
			if (result && typeof result.sequence === "string" && result.sequence.length > 0) {
				return {
					sequence: result.sequence,
					columns: Math.max(1, result.columns),
					rows: Math.max(1, result.rows),
					imageId: options.imageId,
				};
			}
		} catch {
			// fall through to the local encoder
		}
	}
	const cell = await kittyCellDimensions();
	const cells = calculateImageCells(dimensions, cell, options.maxColumns, options.maxRows);
	const stub = encodeKittyStub(base64, { ...cells, imageId: options.imageId });
	return { sequence: stub.sequence, columns: stub.columns, rows: stub.rows, imageId: options.imageId };
}

/** `a=a` — set the display gap for the root frame (frame 1). */
export function encodeKittyRootGap(imageId: number, gapMs: number): string {
	return `\x1b_Ga=a,i=${imageId},r=1,z=${Math.max(1, Math.round(gapMs))},q=2\x1b\\`;
}

/** `a=a,s=3` — start the animation (optionally looping forever). */
export function encodeKittyStart(imageId: number, loopForever: boolean): string {
	return `\x1b_Ga=a,i=${imageId},s=3${loopForever ? ",v=1" : ""},q=2\x1b\\`;
}

/**
 * One animation frame payload (`a=f`). Frame numbering is implicit: kitty
 * appends each `a=f` payload after the previous frame, so the Nth call becomes
 * frame N+1. Continuation chunks keep `a=f` (kitty requires the action on every
 * chunk of a multi-chunk transmission) but must not repeat `c=`/`r=`.
 *
 * `f=100` (PNG) is mandatory on the frame head as well: kitty does NOT inherit
 * the root image's format for `a=f` (`graphics.c`:
 * `uint32_t fmt = g->format ? g->format : RGBA;`, i.e. raw 32-bit RGBA by
 * default). Without it the PNG bytes are measured as raw RGBA, the load aborts
 * with `EINVAL`, and every continuation chunk is rejected — the animation
 * silently degrades to the still root frame.
 */
export function encodeKittyAnimFrame(base64: string, imageId: number, gapMs: number): string {
	const gap = Math.max(1, Math.round(gapMs));
	return encodeKittyChunked(base64, `a=f,f=100,i=${imageId},z=${gap},q=2`, "a=f");
}

/**
 * `a=d,d=I` — free one image (data + every placement) by id.
 *
 * Deleting the image also stops a running `a=a` animation: the extension owns
 * this id, so this is the only way to make the picture disappear when the
 * header goes away (`/splash off`, session shutdown). `d=I` is scoped to our
 * id on purpose — `d=A` would wipe images from other extensions.
 */
export function encodeKittyDelete(imageId: number): string {
	return `\x1b_Ga=d,d=I,i=${imageId},q=2\x1b\\`;
}

/** Swap the image id inside a root sequence's first chunk. */
export function reassignKittyImageId(sequence: string, imageId: number): string {
	const start = sequence.indexOf("\x1b_G");
	if (start < 0) return sequence;
	const semi = sequence.indexOf(";", start);
	if (semi < 0) return sequence;
	const params = sequence.slice(start + 3, semi).split(",");
	const index = params.findIndex((param) => param.startsWith("i="));
	if (index >= 0) params[index] = `i=${imageId}`;
	else params.push(`i=${imageId}`);
	return sequence.slice(0, start + 3) + params.join(",") + sequence.slice(semi);
}

/** Source rectangle + cell grid a cropped root sequence must carry. */
export interface KittyCrop {
	sourceX: number;
	sourceY: number;
	sourceWidth: number;
	sourceHeight: number;
	columns: number;
	rows: number;
}

/**
 * Crop the root sequence to a source rectangle without touching its payload.
 *
 * kitty scales `w`x`h` pixels of the source into `c`x`r` cells, and an animated
 * image applies the rect to every frame, so a short terminal only needs this
 * one head rewrite — no re-encode, no re-upload.
 */
export function cropKittyRoot(sequence: string, crop: KittyCrop): string {
	const start = sequence.indexOf("\x1b_G");
	if (start < 0) return sequence;
	const semi = sequence.indexOf(";", start);
	if (semi < 0) return sequence;
	const params = sequence
		.slice(start + 3, semi)
		.split(",")
		.filter((param) => {
			const key = param.split("=", 1)[0];
			return key !== "x" && key !== "y" && key !== "w" && key !== "h" && key !== "c" && key !== "r";
		});
	params.push(
		`x=${Math.max(0, Math.round(crop.sourceX))}`,
		`y=${Math.max(0, Math.round(crop.sourceY))}`,
		`w=${Math.max(1, Math.round(crop.sourceWidth))}`,
		`h=${Math.max(1, Math.round(crop.sourceHeight))}`,
		`c=${Math.max(1, Math.round(crop.columns))}`,
		`r=${Math.max(1, Math.round(crop.rows))}`,
	);
	return sequence.slice(0, start + 3) + params.join(",") + sequence.slice(semi);
}

export interface KittyFrameSource {
	sequence: string;
	frames: { base64: string }[];
	imageId: number;
	gapMs: number;
}

/**
 * The single line the image band shows.
 *
 * - static/frozen: just the root frame (zero animation traffic).
 * - animated: root frame, its gap, every extra frame, then the start command —
 *   all in one string, because the terminal must not receive anything but
 *   graphics opcodes between the chunks of one transmission.
 */
export function buildKittyLine(options: {
	images: KittyFrameSource;
	animate: boolean;
	loopForever: boolean;
}): string {
	const { sequence, frames, imageId, gapMs } = options.images;
	if (!options.animate || frames.length < 2) return sequence;
	let out = sequence;
	out += encodeKittyRootGap(imageId, gapMs);
	for (let index = 1; index < frames.length; index++) {
		const frame = frames[index];
		if (!frame) continue;
		out += encodeKittyAnimFrame(frame.base64, imageId, gapMs);
	}
	out += encodeKittyStart(imageId, options.loopForever);
	return out;
}

/**
 * Re-chunk an existing root sequence with a different payload.
 *
 * `frames` mode retransmits one frame per tick; the header parameters carry the
 * image id, the cell grid and `C=1`, so they must survive verbatim — only the
 * base64 changes. Extracting the head from `sequence` keeps that guaranteed even
 * when pi-tui's encoder (not ours) produced it.
 */
export function replaceKittyPayload(sequence: string, base64: string): string {
	const start = sequence.indexOf("\x1b_G");
	if (start < 0) return sequence;
	const semi = sequence.indexOf(";", start);
	if (semi < 0) return sequence;
	const head = sequence.slice(start + 3, semi).replace(/,m=1$/, "");
	return sequence.slice(0, start) + encodeKittyChunked(base64, head, "");
}
