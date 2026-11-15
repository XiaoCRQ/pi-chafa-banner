/**
 * pi-chafa-banner — an animated chafa or native-image splash in pi's startup
 * header.
 *
 * Why the header and not a message/overlay: `ctx.ui.setHeader()` replaces the
 * built-in logo inside pi's `headerContainer`, which is a normal child of the
 * document. The splash therefore lives at the top of the transcript, scrolls
 * away naturally as the conversation grows, never captures input, and is
 * disposed by pi when the session reloads or shuts down.
 *
 * Module map:
 *   - `extension/state.ts`    — session state holder, renderer choice, status text
 *   - `extension/session.ts`  — bootstrap, background build, resource refresh
 *   - `extension/header.ts`   — setHeader wiring, listing detach/restore, resize rebuilds
 *   - `extension/commands.ts` — `/splash <subcommand>`
 *   - `banner/`, `layout/`, `text/`, `pipeline/` — pure composition layers
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { handleSplashCommand, SUBCOMMANDS } from "./extension/commands.ts";
import { refreshResources, bootstrap } from "./extension/session.ts";
import { errorText, session } from "./extension/state.ts";

export { describeConfig, loadConfig, loadSessionConfig, setConfigLoader } from "./config.ts";

export default function piChafaBanner(pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		try {
			if (ctx.mode !== "tui") return;
			await bootstrap(pi, ctx);
		} catch (error) {
			ctx.ui.notify(`pi-chafa-banner: ${errorText(error)}`, "warning");
		}
	});

	// Streaming causes pi to re-render the document continuously; stop our timer
	// so the splash cannot add jank to token streaming.
	pi.on("agent_start", () => {
		session.current?.banner?.pause();
	});

	pi.on("agent_end", () => {
		session.current?.banner?.resume();
	});

	// First turn is when pi has actually loaded context files and skills, so use
	// the resolved system prompt options to fill in the panel accurately.
	pi.on("before_agent_start", (event, ctx) => {
		const current = session.current;
		if (!current) return;
		try {
			const options = event.systemPromptOptions;
			const contextFiles = (options.contextFiles ?? []).map((file) => file.path);
			const skills = (options.skills ?? []).map((skill) => skill.name);
			void refreshResources(ctx, current, { contextFiles, skills });
		} catch {
			// ignore malformed events
		}
	});

	pi.on("session_shutdown", (_event, ctx) => {
		try {
			session.current?.banner?.dispose();
			session.current = undefined;
			ctx.ui.setHeader(undefined);
		} catch {
			// shutdown must never fail
		}
	});

	pi.registerCommand("splash", {
		description: "Control the chafa startup banner (on|off|freeze|rebuild|reload|status)",
		getArgumentCompletions: (prefix) => {
			const filtered = SUBCOMMANDS.filter((entry) => entry.value.startsWith(prefix.trim()));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			try {
				await handleSplashCommand(pi, ctx, args);
			} catch (error) {
				ctx.ui.notify(`pi-chafa-banner: ${errorText(error)}`, "error");
			}
		},
	});
}
