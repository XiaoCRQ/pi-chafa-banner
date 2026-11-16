/**
 * Window content providers: the named values a `window` node can pull into a
 * `ContentSpec` (`"content": "version"`, `"content": "context"`, …).
 *
 * A spec whose `content` matches a registered provider is resolved against the
 * live session; anything else is rendered as a literal string, so
 * `"content": "hello"` just works without registering anything. Providers return
 * either a string, a list of names (rendered comma-wrapped or one per line), or
 * `{ value, suffix }` for a trailing badge that must survive truncation.
 */

export type ProviderResult = string | readonly string[] | { value: string; suffix?: string };

/** Everything the built-in providers need, collected once per rebuild. */
export interface ContentContext {
	gifPath: string | undefined;
	version: string;
	model: string;
	thinking: string;
	context: readonly string[];
	skills: readonly string[];
	extensions: readonly string[];
	/** `"3/8"` once frames exist; `undefined` while the canvas is still building. */
	frameCount?: string;
}

export type Provider = (ctx: ContentContext) => ProviderResult;

/**
 * Built-in providers. Values match what the hand-written panels showed before
 * the layout tree existed, so an unchanged config looks unchanged.
 *
 * `model` carries the thinking level as a suffix: it is one short word, and a
 * suffix keeps its own width budget when the model name is long enough to
 * truncate. `"unknown"` means pi has not reported a level yet, so it is omitted.
 */
export const PROVIDERS: Record<string, Provider> = {
	version: (ctx) => ctx.version,
	model: (ctx) =>
		ctx.thinking === "unknown" ? { value: ctx.model } : { value: ctx.model, suffix: `· ${ctx.thinking}` },
	context: (ctx) => ctx.context,
	skills: (ctx) => ctx.skills,
	extensions: (ctx) => ctx.extensions,
};

/**
 * Title and rendered shape of each built-in list section.
 *
 * The legacy panels (`src/banner/panels.ts`) and the v1 config translator
 * (`src/config/legacy.ts`) both need it, and so does anyone documenting the
 * default tree; keeping it here means each title is stated once.
 */
export const SECTION_STYLE: Record<string, { title: string; stacked?: boolean }> = {
	context: { title: "Context" },
	skills: { title: "Skills" },
	extensions: { title: "Extensions", stacked: true },
};

/** Add (or replace) a provider. Later config reloads can reuse the same name. */
export function registerProvider(name: string, fn: Provider): void {
	const key = name.trim();
	if (!key) return;
	PROVIDERS[key] = fn;
}

/**
 * Resolve a `ContentSpec.content` value: a provider result when the name is
 * registered, the literal string otherwise.
 *
 * `names` is only set for list results — the renderer uses it for `stacked`
 * sections, while `value` is the comma-joined form used by inline rows.
 */
export function resolveContent(
	nameOrLiteral: string,
	ctx: ContentContext,
): { value: string; suffix?: string; names?: readonly string[] } {
	const provider = PROVIDERS[nameOrLiteral];
	if (!provider) return { value: nameOrLiteral };
	const result = provider(ctx);
	if (typeof result === "string") return { value: result };
	if (Array.isArray(result)) {
		const names = result as readonly string[];
		return { value: names.join(", "), names };
	}
	const formatted = result as { value: string; suffix?: string };
	const out: { value: string; suffix?: string } = { value: formatted.value ?? "" };
	if (formatted.suffix !== undefined) out.suffix = formatted.suffix;
	return out;
}
