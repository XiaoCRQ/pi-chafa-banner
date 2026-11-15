/**
 * Minimal ambient shim for the parts of `@earendil-works/pi-tui` this extension
 * uses at runtime.
 *
 * Why this file exists: the extension is loaded by pi, where `@earendil-works/*`
 * resolves to pi's own compiled copies — the package must NOT depend on them, so
 * `tsc --noEmit` needs a local declaration. At runtime the dynamic `import()`
 * goes through pi's resolver, which reaches the same module instance the
 * renderer uses (important: kitty image metadata is registered there).
 *
 * Only the surface actually touched is declared; mirrors pi-tui 1.5.x.
 */

declare module "@earendil-works/pi-tui" {
	export type ImageProtocol = "kitty" | "iterm2" | null;

	export interface TerminalCapabilities {
		images: ImageProtocol;
		trueColor: boolean;
		hyperlinks: boolean;
	}

	export interface CellDimensions {
		widthPx: number;
		heightPx: number;
	}

	export interface ImageDimensions {
		widthPx: number;
		heightPx: number;
	}

	export interface RenderImageOptions {
		maxWidthCells?: number;
		maxHeightCells?: number;
		imageId?: number;
		moveCursor?: boolean;
		preserveAspectRatio?: boolean;
	}

	export interface RenderImageResult {
		sequence: string;
		columns: number;
		rows: number;
		imageId?: number;
	}

	export function getCapabilities(): TerminalCapabilities;
	export function getCellDimensions(): CellDimensions;
	export function allocateImageId(): number;
	export function renderImage(
		base64Data: string,
		imageDimensions: ImageDimensions,
		options?: RenderImageOptions,
	): RenderImageResult | null;
}
