import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import piChafaBanner from "../src/index.ts";
import type {
	Component,
	ExtensionAPI,
	ExtensionContext,
	RegisteredCommand,
	Theme,
	TUI,
} from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "../src/text.ts";
import { DEFAULTS, setConfigLoader, type BannerConfig } from "../src/config.ts";

/**
 * These tests drive the real extension entry point against a fake pi host, so
 * the wiring (session_start → setHeader → Banner, /splash subcommands,
 * degradation on a bad gif) is covered without a TUI or a model call.
 */

const theme: Theme = {
	fg: (_token, text) => text,
	bg: (_token, text) => text,
	bold: (text) => text,
	italic: (text) => text,
	underline: (text) => text,
	getColorMode: () => "truecolor",
};

const tui = {
	mode: "inline",
	terminal: { rows: 40, columns: 100 },
	requestRender: () => {},
} as unknown as TUI;

interface Host {
	pi: ExtensionAPI;
	notices: Array<{ message: string; type?: string }>;
	headers: Array<((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined>;
	commands: Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>;
	ctx: ExtensionContext;
	fire(event: string, eventBody: unknown, ctx?: ExtensionContext): Promise<void>;
	render(width?: number): string[];
}

function makeHost(ctxOverrides: Partial<ExtensionContext> = {}): Host {
	const notices: Host["notices"] = [];
	const headers: Host["headers"] = [];
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	const commands: Host["commands"] = new Map();

	const ctx: ExtensionContext = {
		mode: "tui",
		hasUI: true,
		cwd: process.cwd(),
		model: { id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5", provider: "anthropic", api: "anthropic" },
		isIdle: () => true,
		signal: undefined,
		ui: {
			theme,
			setHeader: (factory) => {
				headers.push(factory);
			},
			notify: (message, type) => {
				notices.push({ message, type });
			},
			getAllThemes: () => [{ name: "dark", path: undefined }],
			setStatus: () => {},
		},
		...ctxOverrides,
	} as ExtensionContext;

	const pi = {
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
		registerCommand: (name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
			commands.set(name, options);
		},
		getCommands: () => [],
		getSettings: () => ({ theme: "dark" }),
	} as unknown as ExtensionAPI;

	const host: Host = {
		pi,
		notices,
		headers,
		commands,
		ctx,
		async fire(event, eventBody, ctx2 = ctx) {
			for (const handler of handlers.get(event) ?? []) await handler(eventBody, ctx2);
		},
		render(width = 100) {
			const factory = headers[headers.length - 1];
			if (!factory) return [];
			return factory(tui, theme).render(width);
		},
	};
	return host;
}

async function runCommand(host: Host, args: string): Promise<void> {
	const command = host.commands.get("splash");
	expect(command).toBeDefined();
	await command!.handler(args, host.ctx as never);
}

const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

beforeEach(() => {
	// Tests inject their own config instead of writing pi-chafa-banner.json.
	setConfigLoader(undefined);
	process.env.PI_CODING_AGENT_DIR = join(tmpdir(), `pi-chafa-banner-index-test-${process.pid}`);
});

afterAll(() => {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	setConfigLoader(undefined);
});

describe("extension registration", () => {
	test("registers the lifecycle hooks and the /splash command", () => {
		const host = makeHost();
		piChafaBanner(host.pi);
		expect(host.commands.get("splash")?.description).toContain("banner");
	});

	test("provides argument completions for the subcommands", async () => {
		const host = makeHost();
		piChafaBanner(host.pi);
		const completions = await host.commands.get("splash")!.getArgumentCompletions!("re");
		expect(completions?.map((entry) => entry.value)).toEqual(["rebuild", "reload"]);
	});

	test("does nothing in non-TUI modes", async () => {
		const host = makeHost({ mode: "print" });
		piChafaBanner(host.pi);
		await host.fire("session_start", { type: "session_start", reason: "startup" }, { ...host.ctx, mode: "print" });
		expect(host.headers.length).toBe(0);
	});

	test("never throws when the header factory is invoked before pi is ready", async () => {
		const host = makeHost();
		piChafaBanner(host.pi);
		expect(() => host.render()).not.toThrow();
		expect(host.render()).toEqual([]);
	});
});

describe("session lifecycle", () => {
	test("installs a header that degrades to a diagnostic for a bad gif", async () => {
		// `plans[*].image` is the authority now: the default tree's chafa node has no
		// explicit `img`, so `image.path` seeds it at parse time.
		const badGif = "/nonexistent/x.gif";
		setConfigLoader(() => ({
			...DEFAULTS,
			gifPath: badGif,
			plans: DEFAULTS.plans.map((plan) => ({ ...plan, image: badGif })),
		}));
		const host = makeHost();
		piChafaBanner(host.pi);
		await host.fire("session_start", { type: "session_start", reason: "startup" });
		expect(host.headers.length).toBe(1);

		const first = host.render(100);
		expect(first.join("\n")).toContain("CODING AGENT");
		for (const line of first) expect(visibleWidth(line)).toBeLessThanOrEqual(100);

		// The frame build is asynchronous; give the rejected stat a tick.
		await new Promise((resolve) => setTimeout(resolve, 50));
		const later = host.render(100).join("\n");
		expect(later).toContain("unavailable");
		expect(host.notices.some((notice) => notice.message.includes("pi-chafa-banner"))).toBe(true);
		expect(host.notices.every((notice) => notice.type !== "error")).toBe(true);
	});

	test("agent_start / agent_end are safe without a banner and pause/resume with one", async () => {
		const host = makeHost();
		piChafaBanner(host.pi);
		await host.fire("agent_start", { type: "agent_start" });
		await host.fire("agent_end", { type: "agent_end", messages: [] });
		await host.fire("session_start", { type: "session_start", reason: "startup" });
		await host.fire("agent_start", { type: "agent_start" });
		await host.fire("agent_end", { type: "agent_end", messages: [] });
		expect(host.render(100).length).toBeGreaterThan(0);
	});

	test("before_agent_start refreshes the resources without throwing", async () => {
		const host = makeHost();
		piChafaBanner(host.pi);
		await host.fire("session_start", { type: "session_start", reason: "startup" });
		await host.fire(
			"before_agent_start",
			{
				type: "before_agent_start",
				messageType: "user",
				systemPrompt: "",
				systemPromptOptions: {
					contextFiles: [{ path: "/tmp/project/AGENTS.md", content: "x" }],
					skills: [{ name: "btw", description: "", filePath: "/tmp/btw/SKILL.md", baseDir: "/tmp/btw", sourceInfo: { path: "/tmp/btw/SKILL.md", source: "skill", scope: "user", origin: "package" } }],
				},
			},
			{ mode: "tui", cwd: "/tmp/project" } as ExtensionContext,
		);
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(host.render(100).join("\n")).toContain("RESOURCES");
	});

	test("session_shutdown restores the builtin header", async () => {
		const host = makeHost();
		piChafaBanner(host.pi);
		await host.fire("session_start", { type: "session_start", reason: "startup" });
		await host.fire("session_shutdown", { type: "session_shutdown" });
		expect(host.headers[host.headers.length - 1]).toBeUndefined();
		expect(host.render()).toEqual([]);
	});
});

describe("/splash commands", () => {
	test("status reports the degraded state", async () => {
		const host = makeHost();
		piChafaBanner(host.pi);
		await host.fire("session_start", { type: "session_start", reason: "startup" });
		await runCommand(host, "status");
		const status = host.notices.map((notice) => notice.message).join("\n");
		expect(status).toContain("config");
		expect(status).toContain("image=43x22 (derived)");
		expect(status).toContain("source  built-in defaults");
	});

	test("freeze toggles the animation flag", async () => {
		const host = makeHost();
		piChafaBanner(host.pi);
		await host.fire("session_start", { type: "session_start", reason: "startup" });
		// pi invokes the header factory as soon as setHeader is called; our fake
		// host defers that until the first render, so do it explicitly.
		host.render(100);
		await runCommand(host, "freeze");
		await runCommand(host, "freeze");
		const messages = host.notices.map((notice) => notice.message);
		expect(messages.some((message) => message.includes("frozen"))).toBe(true);
		expect(messages.some((message) => message.includes("animating"))).toBe(true);
	});

	test("off restores the builtin header, on installs a fresh one", async () => {
		const host = makeHost();
		piChafaBanner(host.pi);
		await host.fire("session_start", { type: "session_start", reason: "startup" });
		const before = host.headers.length;

		await runCommand(host, "off");
		expect(host.headers.length).toBe(before + 1);
		expect(host.headers[host.headers.length - 1]).toBeUndefined();

		await runCommand(host, "on");
		expect(host.headers[host.headers.length - 1]).toBeDefined();
		expect(host.render(100).length).toBeGreaterThan(0);
	});

	test("reload re-reads the config file and reports its warnings", async () => {
		setConfigLoader(() => ({
			...DEFAULTS,
			gifPath: "/nonexistent/x.gif",
			source: { path: "/tmp/plugin/pi-chafa-banner.json", warnings: ['image.fps: expected a number between 1 and 30, got "fast"'] },
		}));
		const host = makeHost();
		piChafaBanner(host.pi);
		await host.fire("session_start", { type: "session_start", reason: "startup" });
		await runCommand(host, "reload");
		const message = host.notices.map((notice) => notice.message).join("\n");
		expect(message).toContain("pi-chafa-banner: reload");
		expect(message).toContain("/tmp/plugin/pi-chafa-banner.json");
		expect(message).toContain("image.fps");
	});

	test("unknown subcommands print usage instead of throwing", async () => {
		const host = makeHost();
		piChafaBanner(host.pi);
		await host.fire("session_start", { type: "session_start", reason: "startup" });
		await runCommand(host, "nope");
		expect(host.notices.some((notice) => notice.message.includes("usage: /splash"))).toBe(true);
	});

	test("rebuild reports the failure instead of throwing", async () => {
		const host = makeHost();
		piChafaBanner(host.pi);
		await host.fire("session_start", { type: "session_start", reason: "startup" });
		await runCommand(host, "rebuild");
		expect(host.notices.some((notice) => notice.message.includes("rebuild failed"))).toBe(true);
	});
});

describe("char mode", () => {
	test("the header renders characters and never emits graphics escapes", async () => {
		const host = makeHost();
		piChafaBanner(host.pi);
		await host.fire("session_start", { type: "session_start", reason: "startup" });
		await new Promise((resolve) => setTimeout(resolve, 30));
		const lines = host.render(100);
		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(100);
			expect(line).not.toContain("\x1b_G");
			expect(line).not.toContain("\x1b]1337");
		}
	});
});
