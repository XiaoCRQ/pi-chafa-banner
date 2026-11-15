/**
 * Colour resolution for the boxes: preset → per-role overrides → ANSI.
 *
 * The splash paints four roles (`windowTitle`, `sectionTitle`, `border`,
 * `content`). Each one is a hex colour from `pi-chafa-banner.json` or, when the
 * user did not set it, whatever the preset provides — `"tokyonight"` (the
 * default) pins `TOKYONIGHT_PALETTE`, `"pi"` yields no palette at all so
 * `themePainter` falls back to pi's own theme tokens.
 *
 * Pure: no pi imports, no I/O, so the previewer and the tests use the same code.
 */

import { TOKYONIGHT_PALETTE, parseHexColor, type ThemeSettings } from "../config/schema.ts";

/** The four paintable roles, resolved to lowercase `#rrggbb` (or unset). */
export interface Palette {
	windowTitle?: string;
	sectionTitle?: string;
	border?: string;
	content?: string;
}

/** Structurally compatible with `ThemeSettings`, so callers pass the config. */
export type PaletteSettings = Partial<Pick<ThemeSettings, "preset">> & Palette;

/**
 * Merge the preset with the user's overrides. Overrides always win, including
 * over a preset colour; an unknown preset degrades to `"pi"` (no palette).
 */
export function resolvePalette(settings?: PaletteSettings): Palette {
	const preset = settings?.preset === "tokyonight" ? TOKYONIGHT_PALETTE : undefined;
	const pick = (explicit: string | undefined, fallback: string | undefined) =>
		parseHexColor(explicit) ?? fallback;
	return {
		windowTitle: pick(settings?.windowTitle, preset?.windowTitle),
		sectionTitle: pick(settings?.sectionTitle, preset?.sectionTitle),
		border: pick(settings?.border, preset?.border),
		content: pick(settings?.content, preset?.content),
	};
}

/** `#rrggbb` -> [r, g, b]; undefined for anything else. */
export function hexToRgb(hex: string): [number, number, number] | undefined {
	const normalized = parseHexColor(hex);
	if (!normalized) return undefined;
	const value = Number.parseInt(normalized.slice(1), 16);
	return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

function toCubeLevel(channel: number): number {
	return Math.round((channel / 255) * 5);
}

/**
 * Nearest xterm-256 index: the 6x6x6 colour cube (16-231) or the 24-step grey
 * ramp (232-255), whichever is closer. Ported from the usual
 * `rgbToAnsi256` used by chalk/ansi-styles.
 */
export function rgbTo256(r: number, g: number, b: number): number {
	const rq = toCubeLevel(r);
	const gq = toCubeLevel(g);
	const bq = toCubeLevel(b);
	const cube = [rq * 51, gq * 51, bq * 51];
	const cubeDistance = (r - cube[0]!) ** 2 + (g - cube[1]!) ** 2 + (b - cube[2]!) ** 2;

	const average = Math.round((r + g + b) / 3);
	const greyIndex = Math.min(23, Math.max(0, Math.round((average - 8) / 10)));
	const grey = 8 + greyIndex * 10;
	const greyDistance = (r - grey) ** 2 + (g - grey) ** 2 + (b - grey) ** 2;

	return greyDistance < cubeDistance ? 232 + greyIndex : 16 + 36 * rq + 6 * gq + bq;
}

/**
 * The SGR prefix for `hex`, or undefined when the colour cannot be parsed.
 *
 * `truecolor` emits 24-bit SGR, `256color` the nearest palette entry; callers
 * append the text and their own reset (`ESC[39m` restores the default
 * foreground, not a full SGR reset, so bold from an outer wrapper survives —
 * same contract as pi's theme `fg()`).
 */
export function foregroundCode(hex: string, mode: "truecolor" | "256color" = "truecolor"): string | undefined {
	const rgb = hexToRgb(hex);
	if (!rgb) return undefined;
	const [r, g, b] = rgb;
	return mode === "256color" ? `\x1b[38;5;${rgbTo256(r, g, b)}m` : `\x1b[38;2;${r};${g};${b}m`;
}

/** Wrap `text` in a foreground colour and reset it afterwards. */
export function paintForeground(hex: string, text: string, mode: "truecolor" | "256color" = "truecolor"): string {
	const code = foregroundCode(hex, mode);
	return code === undefined ? text : `${code}${text}\x1b[39m`;
}

/** Human-readable palette for `/splash status`; `pi` roles are theme-driven. */
export function describePalette(settings: ThemeSettings): string {
	const palette = resolvePalette(settings);
	const roles = (["windowTitle", "sectionTitle", "border", "content"] as const).map(
		(role) => `${role}=${palette[role] ?? "theme"}`,
	);
	return `${settings.preset} ${roles.join(" ")}`;
}
