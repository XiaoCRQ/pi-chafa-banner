/**
 * ANSI-aware text measurement and truncation.
 *
 * Why not `visibleWidth()` from `@earendil-works/pi-tui`? That package is
 * host-provided and only resolvable inside a running pi process. The layout
 * module must stay usable from plain `bun test` / `bun run scripts/preview.ts`
 * (no pi, no node_modules), so the two primitives we need live here.
 *
 * The contract must match pi-tui's `visibleWidth` EXACTLY, in both directions:
 *   - underestimating lets a line exceed `width` and break pi's renderer;
 *   - overestimating pads too little, shifting the right border of our boxes.
 * pi-tui measures grapheme clusters with Unicode East Asian Width (W/F => 2)
 * plus an RGI_Emoji check (emoji sequences => 2). We mirror that here: grapheme
 * segmentation via `Intl.Segmenter`, the Unicode wide/fullwidth tables, and
 * `\p{RGI_Emoji}` (constructed dynamically so older runtimes degrade safely).
 */

// CSI, OSC, and short ESC sequences. Chafa only emits SGR (CSI ... m) and
// cursor/clear codes, but themes add OSC-8 links, so handle both.
const ANSI_RE = /\x1b\[[0-9;:?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;

export function stripAnsi(input: string): string {
	return input.replace(ANSI_RE, "");
}

// ---------------------------------------------------------------------------
// grapheme width (mirrors @earendil-works/pi-tui's utils.ts)
// ---------------------------------------------------------------------------

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

const ZERO_WIDTH_CLUSTER_RE =
	/^(?:\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Mark}|\p{Surrogate})+$/u;
const LEADING_NON_PRINTING_RE =
	/^[\p{Default_Ignorable_Code_Point}\p{Control}\p{Format}\p{Mark}\p{Surrogate}]+/u;
const NON_PRINTING_CHAR_RE =
	/^(?:\p{Default_Ignorable_Code_Point}|\p{Control}|\p{Format}|\p{Mark}|\p{Surrogate})$/u;
const MARK_CHAR_RE = /^\p{Mark}$/u;
const SPACING_MARK_RE = /^\p{Spacing_Mark}$/u;

/** Spacing marks that terminals allocate a cell for even without a base char. */
const SPACING_MARK_EXCEPTIONS_RE = /^[\u1734\u302e\u302f]+$/u;
const EXTRA_SPACING_MARKS_RE = /^[\u065f\u0f7f\u102b\u102c\u1031\u1033-\u1035\u1038\u103a-\u103e]+$/u;

/**
 * Unicode East Asian Width tables (fullwidth + wide), copied from
 * `get-east-asian-width` (MIT). Flat [start, end, start, end, ...] pairs.
 */
const FULLWIDTH_RANGES: readonly number[] = [12288, 12288, 65281, 65376, 65504, 65510];
const WIDE_RANGES: readonly number[] = [
	4352, 4447, 8986, 8987, 9001, 9002, 9193, 9196, 9200, 9200, 9203, 9203, 9725, 9726, 9748, 9749,
	9776, 9783, 9800, 9811, 9855, 9855, 9866, 9871, 9875, 9875, 9889, 9889, 9898, 9899, 9917, 9918,
	9924, 9925, 9934, 9934, 9940, 9940, 9962, 9962, 9970, 9971, 9973, 9973, 9978, 9978, 9981, 9981,
	9989, 9989, 9994, 9995, 10024, 10024, 10060, 10060, 10062, 10062, 10067, 10069, 10071, 10071,
	10133, 10135, 10160, 10160, 10175, 10175, 11035, 11036, 11088, 11088, 11093, 11093, 11904, 11929,
	11931, 12019, 12032, 12245, 12272, 12287, 12289, 12350, 12353, 12438, 12441, 12543, 12549, 12591,
	12593, 12686, 12688, 12773, 12783, 12830, 12832, 12871, 12880, 42124, 42128, 42182, 43360, 43388,
	44032, 55203, 63744, 64255, 65040, 65049, 65072, 65106, 65108, 65126, 65128, 65131, 94176, 94180,
	94192, 94198, 94208, 101589, 101631, 101662, 101760, 101874, 110576, 110579, 110581, 110587,
	110589, 110590, 110592, 110882, 110898, 110898, 110928, 110930, 110933, 110933, 110948, 110951,
	110960, 111355, 119552, 119638, 119648, 119670, 126980, 126980, 127183, 127183, 127374, 127374,
	127377, 127386, 127488, 127490, 127504, 127547, 127552, 127560, 127568, 127569, 127584, 127589,
	127744, 127776, 127789, 127797, 127799, 127868, 127870, 127891, 127904, 127946, 127951, 127955,
	127968, 127984, 127988, 127988, 127992, 128062, 128064, 128064, 128066, 128252, 128255, 128317,
	128331, 128334, 128336, 128359, 128378, 128378, 128405, 128406, 128420, 128420, 128507, 128591,
	128640, 128709, 128716, 128716, 128720, 128722, 128725, 128728, 128732, 128735, 128747, 128748,
	128756, 128764, 128992, 129003, 129008, 129008, 129292, 129338, 129340, 129349, 129351, 129535,
	129648, 129660, 129664, 129674, 129678, 129734, 129736, 129736, 129741, 129756, 129759, 129770,
	129775, 129784, 131072, 196605, 196608, 262141,
];

function inRanges(cp: number, ranges: readonly number[]): boolean {
	let low = 0;
	let high = ranges.length / 2 - 1;
	while (low <= high) {
		const mid = (low + high) >> 1;
		const start = ranges[mid * 2]!;
		const end = ranges[mid * 2 + 1]!;
		if (cp < start) high = mid - 1;
		else if (cp > end) low = mid + 1;
		else return true;
	}
	return false;
}

/** Unicode East Asian Width: W/F => 2, everything else (incl. ambiguous) => 1. */
function eastAsianWidth(cp: number): number {
	return inRanges(cp, FULLWIDTH_RANGES) || inRanges(cp, WIDE_RANGES) ? 2 : 1;
}

// `v` flag needs Node >= 20 / Bun; construct it lazily so a missing flag just
// degrades to the range heuristic in `couldBeEmoji`.
let rgiEmojiRegex: RegExp | undefined;
try {
	rgiEmojiRegex = new RegExp("^\\p{RGI_Emoji}$", "v");
} catch {
	rgiEmojiRegex = undefined;
}

/** Cheap pre-filter so the RGI regex only runs on plausible emoji clusters. */
function couldBeEmoji(segment: string): boolean {
	const cp = segment.codePointAt(0);
	if (cp === undefined) return false;
	return (
		(cp >= 0x1f000 && cp <= 0x1fbff) ||
		(cp >= 0x2300 && cp <= 0x23ff) ||
		(cp >= 0x2600 && cp <= 0x27bf) ||
		(cp >= 0x2b50 && cp <= 0x2b55) ||
		segment.includes("\ufe0f") ||
		segment.length > 2
	);
}

function isTerminalSpacingCluster(segment: string): boolean {
	if (SPACING_MARK_EXCEPTIONS_RE.test(segment)) return false;
	if (SPACING_MARK_RE.test(segment)) return true;
	return EXTRA_SPACING_MARKS_RE.test(segment);
}

function isTerminalSpacingChar(char: string): boolean {
	if (SPACING_MARK_EXCEPTIONS_RE.test(char)) return false;
	if (SPACING_MARK_RE.test(char)) return true;
	return EXTRA_SPACING_MARKS_RE.test(char);
}

/**
 * Terminal width of one grapheme cluster. This follows pi-tui's graphemeWidth:
 * RGI emoji sequences (ZWJ families, skin tones, VS16, flags) are 2 columns,
 * never the sum of their code points.
 */
export function graphemeWidth(segment: string): number {
	if (segment.length === 1) {
		const code = segment.charCodeAt(0);
		if (code >= 0x20 && code <= 0x7e) return 1;
		if (code === 0x09) return 3; // pi-tui expands tabs to three spaces
	}
	if (isTerminalSpacingCluster(segment)) return [...segment].length;
	if (ZERO_WIDTH_CLUSTER_RE.test(segment)) return 0;
	if (rgiEmojiRegex && couldBeEmoji(segment) && rgiEmojiRegex.test(segment)) return 2;

	const base = segment.replace(LEADING_NON_PRINTING_RE, "");
	const cp = base.codePointAt(0);
	if (cp === undefined) return 0;
	// Regional indicators render full-width even in isolation.
	if (cp >= 0x1f1e6 && cp <= 0x1f1ff) return 2;

	let width = eastAsianWidth(cp);
	let followsMark = false;
	for (const char of [...base].slice(1)) {
		if (isTerminalSpacingChar(char)) {
			width += 1;
			followsMark = false;
		} else if (MARK_CHAR_RE.test(char)) {
			followsMark = true;
		} else if (!NON_PRINTING_CHAR_RE.test(char)) {
			const c = char.codePointAt(0)!;
			if (followsMark || (c >= 0xff00 && c <= 0xffef)) width += eastAsianWidth(c);
			else if (c === 0x0e33 || c === 0x0eb3) width += 1; // Thai/Lao AM vowels
			followsMark = false;
		}
	}
	return width;
}

/** Legacy single-code-point helper (kept for callers/tests). */
export function codePointWidth(cp: number, cpStr: string): number {
	return graphemeWidth(cpStr || String.fromCodePoint(cp));
}

const WIDTH_CACHE_SIZE = 512;
const widthCache = new Map<string, number>();

export function visibleWidth(input: string): number {
	if (input.length === 0) return 0;
	// Fast path: printable ASCII (the common case for box borders and names).
	let ascii = true;
	for (let i = 0; i < input.length; i++) {
		const code = input.charCodeAt(i);
		if (code < 0x20 || code > 0x7e) {
			ascii = false;
			break;
		}
	}
	if (ascii) return input.length;

	const cached = widthCache.get(input);
	if (cached !== undefined) return cached;

	const plain = stripAnsi(input);
	let width = 0;
	for (const { segment } of graphemeSegmenter.segment(plain)) width += graphemeWidth(segment);

	if (widthCache.size >= WIDTH_CACHE_SIZE) {
		const first = widthCache.keys().next().value;
		if (first !== undefined) widthCache.delete(first);
	}
	widthCache.set(input, width);
	return width;
}

/** Longest visible width across lines; 0 for an empty array. */
export function maxVisibleWidth(lines: readonly string[]): number {
	let max = 0;
	for (const line of lines) max = Math.max(max, visibleWidth(line));
	return max;
}

function padWithSpaces(line: string, target: number): string {
	const gap = target - visibleWidth(line);
	return gap > 0 ? line + " ".repeat(gap) : line;
}

/** Append spaces so the line occupies exactly `target` columns (never truncates). */
export function padVisible(line: string, target: number): string {
	return padWithSpaces(line, Math.max(0, target));
}

/** Center to exactly `target` columns when the line is narrower. */
export function centerVisible(line: string, target: number): string {
	const gap = target - visibleWidth(line);
	if (gap <= 0) return line;
	const left = Math.floor(gap / 2);
	return " ".repeat(left) + line + " ".repeat(gap - left);
}

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
	const limit = Math.max(0, maxWidth);
	if (visibleWidth(text) <= limit) return pad ? padWithSpaces(text, limit) : text;

	const ellipsisWidth = visibleWidth(ellipsis);
	// If the ellipsis alone eats the budget, degrade to a hard width cut.
	const target = ellipsisWidth >= limit ? limit : limit - ellipsisWidth;
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

	out += ellipsisWidth >= limit ? "" : ellipsis;
	// Close any SGR left open by the theme wrapper we cut through.
	if (sawAnsi) out += "\x1b[0m";
	return pad ? padWithSpaces(out, limit) : out;
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
