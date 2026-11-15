/**
 * ANSI/APC recognition: which escapes are zero-width, and which lines carry an
 * inline image (kitty or iTerm2) instead of text.
 *
 * pi's renderer treats those lines specially (they reserve rows rather than
 * cells), so this predicate has to be byte-identical to pi-tui's `isImageLine`.
 */

// CSI, OSC, APC, and short ESC sequences. Chafa only emits SGR (CSI ... m) and
// cursor/clear codes, but themes add OSC-8 links and kitty images are APC
// (`ESC _ G ... ST`), so handle all three. The APC branch only swallows the
// sequence when it is *terminated* (BEL or ST); an unterminated APC falls
// through to the generic `\x1b[@-_]` branch, which mirrors pi-tui's
// `ansiCodeLength` returning 0 there (the payload then counts as visible).
export const ANSI_RE =
	/\x1b\[[0-9;:?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;

// kitty graphics protocol and iTerm2 inline images both arrive as zero-width
// control sequences that span one "line" but occupy a whole cell block.
export const KITTY_IMAGE_PREFIX = "\x1b_G";
export const ITERM2_IMAGE_PREFIX = "\x1b]1337;File=";

/**
 * Whether a rendered line carries an inline image. Byte-for-byte the same
 * semantics as pi-tui's `isImageLine` (terminal-image.ts), which is not
 * re-exported from the package entry point.
 */
export function isImageLine(line: string): boolean {
	return (
		line.startsWith(KITTY_IMAGE_PREFIX) ||
		line.startsWith(ITERM2_IMAGE_PREFIX) ||
		line.includes(KITTY_IMAGE_PREFIX) ||
		line.includes(ITERM2_IMAGE_PREFIX)
	);
}

export function stripAnsi(input: string): string {
	return input.replace(ANSI_RE, "");
}

// ---------------------------------------------------------------------------
// grapheme width (mirrors @earendil-works/pi-tui's utils.ts)
// ---------------------------------------------------------------------------
