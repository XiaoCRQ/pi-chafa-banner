/**
 * ANSI-aware truncation and padding.
 *
 * Every function keeps escape sequences intact and treats an inline image
 * sequence as atomic: cutting one corrupts the kitty/iTerm2 protocol.
 */

import { ANSI_RE, isImageLine } from "./ansi.ts";
import { graphemeSegmenter, graphemeWidth, padWithSpaces, visibleWidth } from "./width.ts";


// ---------------------------------------------------------------------------
// ANSI-aware grapheme iteration
// ---------------------------------------------------------------------------

interface Token {
	ansi: boolean;
	text: string;
	width: number;
}

/**
 * Yield ANSI escape sequences and visible grapheme clusters in order. The input
 * is split at ESC boundaries first so `Intl.Segmenter` never has to reason
 * about control sequences.
 */
function* tokens(text: string): Generator<Token> {
	let i = 0;
	while (i < text.length) {
		if (text[i] === "\x1b") {
			ANSI_RE.lastIndex = i;
			const match = ANSI_RE.exec(text);
			if (match && match.index === i) {
				yield { ansi: true, text: match[0], width: 0 };
				i += match[0].length;
				continue;
			}
		}
		const nextEsc = text.indexOf("\x1b", i);
		if (nextEsc === i) {
			// Escape that is not a sequence we understand: consume it as a
			// zero-width character so the loop always advances.
			yield { ansi: false, text: "\x1b", width: 0 };
			i += 1;
			continue;
		}
		const end = nextEsc === -1 ? text.length : nextEsc;
		const chunk = text.slice(i, end);
		for (const { segment } of graphemeSegmenter.segment(chunk)) {
			yield { ansi: false, text: segment, width: graphemeWidth(segment) };
		}
		i = end;
	}
}

/**
 * Truncate to `maxWidth` visible columns, keeping ANSI sequences intact and
 * appending `ellipsis` when anything was cut. `pad = true` pads to exactly
 * `maxWidth` (pi-tui semantics).
 */
export function truncateToWidth(text: string, maxWidth: number, ellipsis = "...", pad = false): string {
	// Image sequences are atomic and zero-width; cutting them corrupts the
	// protocol. `pad` is ignored for the same reason (see padWithSpaces).
	if (isImageLine(text)) return text;
	const limit = Math.max(0, maxWidth);
	if (visibleWidth(text) <= limit) return pad ? padWithSpaces(text, limit) : text;

	const ellipsisWidth = visibleWidth(ellipsis);
	// When the ellipsis cannot fit either, pi-tui drops the text and clips the
	// ellipsis into the whole budget (`truncateFragmentToWidth`) instead of
	// showing an ellipsis-less cut.
	const clipped = ellipsisWidth >= limit;
	const target = clipped ? 0 : limit - ellipsisWidth;
	let out = "";
	let width = 0;
	let sawAnsi = false;

	for (const token of tokens(text)) {
		// Copy escape sequences verbatim: they cost zero columns.
		if (token.ansi) {
			out += token.text;
			sawAnsi = true;
			continue;
		}
		if (width + token.width > target) break;
		out += token.text;
		width += token.width;
	}

	out += clipped ? truncateEllipsis(ellipsis, limit - width) : ellipsis;
	// Close any SGR left open by the theme wrapper we cut through.
	if (sawAnsi) out += "\x1b[0m";
	return pad ? padWithSpaces(out, limit) : out;
}

/**
 * Widest prefix of `ellipsis` that fits in `budget` columns.
 *
 * pi-tui clips the ellipsis into the remaining budget when it does not fit
 * (`truncateFragmentToWidth`), so a 1-column line ends with `…`/`.` instead of
 * going blank. Matching that keeps our output identical to pi's on narrow box
 * titles and panel rows.
 */
function truncateEllipsis(ellipsis: string, budget: number): string {
	if (budget <= 0) return "";
	let out = "";
	let width = 0;
	for (const token of tokens(ellipsis)) {
		if (token.ansi) {
			out += token.text;
			continue;
		}
		if (width + token.width > budget) break;
		out += token.text;
		width += token.width;
	}
	return out;
}

/** Visible-column slice, ANSI preserved. Used to clip images that are wider than the terminal. */
export function sliceVisible(text: string, start: number, length: number): string {
	const limit = Math.max(0, length);
	if (limit === 0) return "";
	let out = "";
	let col = 0;
	let emitted = 0;
	for (const token of tokens(text)) {
		if (token.ansi) {
			out += token.text;
			continue;
		}
		if (col >= start && emitted + token.width <= limit) {
			out += token.text;
			emitted += token.width;
		}
		col += token.width;
		if (emitted >= limit) break;
	}
	return out;
}

