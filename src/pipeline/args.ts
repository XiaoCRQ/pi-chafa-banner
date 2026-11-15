/**
 * User-supplied chafa arguments (`image.chafa` in the JSON file).
 *
 * The pipeline owns a few flags for its own safety: `--probe off` keeps chafa
 * from blocking on a terminal DA reply and stealing pi's stdin, `--animate off`
 * makes every invocation produce exactly one frame, and `--clear` would emit
 * `ESC[2J`/`ESC[0H` into the middle of pi's document. Users may tune everything
 * else (symbols, dithering, colour space, …), so their string is split like a
 * shell would split it and the unsafe flags are dropped.
 */

/** Flags the pipeline always sets itself; a user copy would break it. */
const RESERVED = ["--probe", "--animate", "--clear"];

/** Longest `image.chafa` accepted; anything longer is almost certainly a mistake. */
export const MAX_CHAFA_ARGS_LENGTH = 512;

/**
 * Split `input` into argv, honouring single/double quotes and backslashes.
 *
 * Deliberately small: no globbing, no variables, no command substitution — this
 * is a config value, not a shell line.
 */
export function splitArgs(input: string): string[] {
	const args: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	let has = false;
	for (let index = 0; index < input.length; index++) {
		const char = input[index] as string;
		if (char === "\\" && quote !== "'" && index + 1 < input.length) {
			current += input[index + 1];
			has = true;
			index += 1;
			continue;
		}
		if (quote) {
			if (char === quote) quote = undefined;
			else current += char;
			has = true;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			has = true;
			continue;
		}
		if (/\s/.test(char)) {
			if (has) {
				args.push(current);
				current = "";
				has = false;
			}
			continue;
		}
		current += char;
		has = true;
	}
	if (has) args.push(current);
	return args;
}

/**
 * Drop the flags the pipeline must control.
 *
 * `--probe on` (or a bare `--probe`) would block the pipeline on terminal
 * handshakes; `--clear` would paint escape sequences pi cannot account for.
 */
export function sanitizeChafaArgs(args: readonly string[]): string[] {
	const out: string[] = [];
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] as string;
		const name = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
		if (!RESERVED.includes(name)) {
			out.push(arg);
			continue;
		}
		// `--probe off` is a two-token form: swallow its value as well.
		const next = args[index + 1];
		if (!arg.includes("=") && next !== undefined && !next.startsWith("-")) index += 1;
	}
	return out;
}

/** `image.chafa` → the argv the pipeline appends to its own flags. */
export function parseChafaArgs(raw: string | undefined): string[] {
	if (!raw) return [];
	return sanitizeChafaArgs(splitArgs(raw.slice(0, MAX_CHAFA_ARGS_LENGTH)));
}

/**
 * Short stable digest of a user argv, used in cache file names.
 *
 * `image.chafa` changes the rendered pixels, so it belongs in the cache key:
 * without it, tweaking a flag would keep serving the frames chafa produced for
 * the previous flags.
 */
export function argsDigest(args: readonly string[]): string {
	if (args.length === 0) return "";
	let hash = 2166136261;
	for (const arg of args) {
		for (let index = 0; index < arg.length; index++) {
			hash ^= arg.charCodeAt(index);
			hash = Math.imul(hash, 16777619) >>> 0;
		}
		hash ^= 0x1f; // separator, so ["ab","c"] and ["a","bc"] differ
		hash = Math.imul(hash, 16777619) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}
