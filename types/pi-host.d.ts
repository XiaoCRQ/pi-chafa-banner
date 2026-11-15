/**
 * Minimal ambient shim for the pi host API.
 *
 * Why this file exists: the extension is loaded by pi at runtime, where bare
 * specifiers such as `@earendil-works/pi-coding-agent` are aliased to pi's own
 * compiled copies (see docs/extensions.md). The package itself must NOT depend
 * on those packages (they are host-provided, not installable dev deps), so
 * `tsc --noEmit` needs a local declaration to check against.
 *
 * Only the surface this extension actually touches is declared. Every member
 * mirrors pi 1.5.x; if you upgrade pi and need more API, add it here.
 */

declare module "@earendil-works/pi-coding-agent" {
	/** Theme color tokens used by the banner. Kept loose so new pi tokens do not break builds. */
	export type ThemeColor =
		| "accent"
		| "border"
		| "borderAccent"
		| "borderMuted"
		| "dim"
		| "muted"
		| "text"
		| "mdHeading"
		| "mdLink"
		| "mdCode"
		| "success"
		| "error"
		| "warning"
		| "toolTitle"
		| (string & {});

	export type ThemeBg = ThemeColor;

	export type TerminalColorMode = "truecolor" | "256color" | "ansi" | "none";

	export interface Theme {
		fg(color: ThemeColor, text: string): string;
		bg(color: ThemeBg, text: string): string;
		bold(text: string): string;
		italic(text: string): string;
		underline(text: string): string;
		getColorMode(): TerminalColorMode;
	}

	export interface TerminalLike {
		rows: number;
		columns: number;
		/** pi-tui's `Terminal.write`: synchronous stdout write, used to free kitty images. */
		write?(data: string): void;
	}

	export interface TUI {
		/** pi-tui's main screen is "regular"; "fullscreen" is the alternate screen. */
		mode: "regular" | "fullscreen";
		terminal: TerminalLike;
		requestRender(force?: boolean): void;
	}

	export interface Component {
		render(width: number): string[];
		invalidate(): void;
		dispose?(): void;
	}

	export interface SourceInfo {
		path: string;
		source: string;
		scope: "user" | "project" | "temporary";
		origin: "package" | "top-level";
		baseDir?: string;
		changelogPath?: string;
	}

	export type SlashCommandSource = "extension" | "prompt" | "skill";

	export interface SlashCommandInfo {
		name: string;
		description?: string;
		source: SlashCommandSource;
		sourceInfo: SourceInfo;
	}

	export interface PackageSourceObject {
		source: string;
		extensions?: string[];
		skills?: string[];
		themes?: string[];
	}

	export interface Settings {
		theme?: string;
		quietStartup?: boolean | "header";
		extensions?: string[];
		skills?: string[];
		themes?: string[];
		packages?: Array<string | PackageSourceObject>;
		[key: string]: unknown;
	}

	export interface Model<TApi extends string = string> {
		id: string;
		name?: string;
		provider: string;
		api: TApi;
	}

	export interface Skill {
		name: string;
		description: string;
		filePath: string;
		baseDir: string;
		sourceInfo: SourceInfo;
	}

	export interface NormalizedBuildSystemPromptOptions {
		contextFiles: Array<{ path: string; content: string }>;
		skills: Skill[];
		[key: string]: unknown;
	}

	export interface AgentMessage {
		role: string;
	}

	export interface SessionStartEvent {
		type: "session_start";
		reason: "startup" | "reload" | "new" | "resume" | "fork";
		previousSessionFile?: string;
	}

	export interface SessionShutdownEvent {
		type: "session_shutdown";
	}

	export interface AgentStartEvent {
		type: "agent_start";
	}

	export interface AgentEndEvent {
		type: "agent_end";
		messages: AgentMessage[];
	}

	export interface BeforeAgentStartEventBase {
		type: "before_agent_start";
		readonly systemPrompt: string;
		systemPromptOptions: NormalizedBuildSystemPromptOptions;
	}

	export interface BeforeAgentStartEvent extends BeforeAgentStartEventBase {
		messageType: "user" | "custom";
		[key: string]: unknown;
	}

	export type ExtensionMode = "tui" | "rpc" | "json" | "print";

	export interface ExtensionUIContext {
		readonly theme: Theme;
		setHeader(factory: ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined): void;
		notify(message: string, type?: "info" | "warning" | "error"): void;
		getAllThemes(): Array<{ name: string; path: string | undefined }>;
		setStatus(key: string, text: string | undefined): void;
		[key: string]: unknown;
	}

	export interface ExtensionContext {
		ui: ExtensionUIContext;
		mode: ExtensionMode;
		hasUI: boolean;
		cwd: string;
		model: Model | undefined;
		isIdle(): boolean;
		signal: AbortSignal | undefined;
		[key: string]: unknown;
	}

	export interface ExtensionCommandContext extends ExtensionContext {
		waitForIdle?(): Promise<void>;
	}

	export interface RegisteredCommand {
		name: string;
		sourceInfo: SourceInfo;
		description?: string;
		getArgumentCompletions?: (
			argumentPrefix: string,
		) => Array<{ value: string; label: string; description?: string }> | null | Promise<Array<{ value: string; label: string; description?: string }> | null>;
		handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
	}

	export type ExtensionHandler<E, R = undefined> = (event: E, ctx: ExtensionContext) => Promise<R | void> | R | void;

	export interface ExtensionAPI {
		on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): () => void;
		on(event: "session_shutdown", handler: ExtensionHandler<SessionShutdownEvent>): () => void;
		on(event: "agent_start", handler: ExtensionHandler<AgentStartEvent>): () => void;
		on(event: "agent_end", handler: ExtensionHandler<AgentEndEvent>): () => void;
		on(event: "before_agent_start", handler: ExtensionHandler<BeforeAgentStartEvent>): () => void;
		on(event: string, handler: ExtensionHandler<unknown, unknown>): () => void;

		registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void;
		getCommands(): SlashCommandInfo[];
		getSettings(): Settings;

		/** pi's own version, exported by the host package. */
		[key: string]: unknown;
	}

	export const VERSION: string;
}
