/**
 * Resource collection: the info card's version/thinking and the `pkg:entry`
 * labels of the RESOURCES panel. No pi process, no network — manifests are
 * written into a temp agent dir.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	collectResources,
	compactPathLabels,
	labelFromSourceInfo,
	getPiVersion,
	packageEntryLabel,
	packageNameFromSpec,
	packageShortName,
	parsePiVersion,
} from "../src/resources.ts";
import type { Settings } from "@earendil-works/pi-coding-agent";

const roots: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-chafa-banner-res-"));
	roots.push(dir);
	return dir;
}

function writeManifest(dir: string, name: string, extensions: unknown, extra: Record<string, unknown> = {}): void {
	const target = join(dir, "npm", "node_modules", name);
	mkdirSync(target, { recursive: true });
	writeFileSync(join(target, "package.json"), JSON.stringify({ name, version: "0.0.0", pi: { extensions }, ...extra }));
}

afterAll(() => {
	for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

describe("pi version", () => {
	test("parses `pi -v` output", () => {
		expect(parsePiVersion("1.5.2\n")).toBe("1.5.2");
		expect(parsePiVersion("  1.5.2")).toBe("1.5.2");
		expect(parsePiVersion("pi 0.9.0-beta.1")).toBe("0.9.0-beta.1");
		expect(parsePiVersion("")).toBe("?.?.?");
		expect(parsePiVersion("command not found")).toBe("?.?.?");
	});

	test("reads the installed pi", async () => {
		// `pi -v` is a ~150ms spawn that the module caches for the whole process.
		expect(await getPiVersion()).toMatch(/^\d+\.\d+|^\?\.\?\.\?$/);
	});
});

describe("packageNameFromSpec", () => {
	test("strips the npm: scheme and any version range", () => {
		expect(packageNameFromSpec("npm:pi-btw")).toBe("pi-btw");
		expect(packageNameFromSpec("npm:@scope/pkg@1.2.3")).toBe("@scope/pkg");
		expect(packageNameFromSpec("npm:@scope/pkg")).toBe("@scope/pkg");
	});

	test("ignores everything that is not an npm spec", () => {
		expect(packageNameFromSpec("~/src/pi-chafa-banner")).toBeUndefined();
		expect(packageNameFromSpec("./extensions")).toBeUndefined();
		expect(packageNameFromSpec("")).toBeUndefined();
	});
});

describe("packageEntryLabel", () => {
	// The exact shapes pi prints on startup for the machine this was written on.
	test("renders installed packages as pkg:entry, exactly like pi", () => {
		const cases: Array<[string, string | undefined, string]> = [
			["@graelo/pi-vim", "./src/index.ts", "@graelo/pi-vim:src"],
			["@juicesharp/rpiv-ask-user-question", "./index.ts", "@juicesharp/rpiv-ask-user-question"],
			["@narumitw/pi-usage", "./dist/index.ts", "@narumitw/pi-usage:dist"],
			["@plannotator/pi-extension", "./", "@plannotator/pi-extension:"],
			["@quintinshaw/pi-dynamic-workflows", "extensions/workflow.ts", "@quintinshaw/pi-dynamic-workflows:workflow.ts"],
			["billion-context", "./dist/agent/billion-context.js", "billion-context:dist/agent/billion-context.js"],
			["pi-btw", "./extensions/btw.ts", "pi-btw:btw.ts"],
			["pi-starline", "./starline/index.ts", "pi-starline:starline"],
			["pi-web-access", "./dist", "pi-web-access:dist"],
		];
		for (const [name, entry, expected] of cases) expect(packageEntryLabel(name, entry)).toBe(expected);
	});

	test("only an index entry collapses; other files keep their name", () => {
		expect(packageEntryLabel("pkg", "./main.js")).toBe("pkg:main.js");
		expect(packageEntryLabel("pkg", "extensions/bridge.ts")).toBe("pkg:bridge.ts");
		expect(packageEntryLabel("pkg", undefined)).toBe("pkg");
	});

	test("packageShortName drops the scope and the pi- prefix", () => {
		expect(packageShortName("pi-btw")).toBe("btw");
		expect(packageShortName("@scope/pi-thing")).toBe("thing");
		expect(packageShortName("@scope/plain")).toBe("plain");
		expect(packageShortName("pi-")).toBe("pi-");
	});
});

describe("compactPathLabels", () => {
	test("shortens local extensions to the shortest unique suffix", () => {
		expect(compactPathLabels(["/home/u/.pi/agent/extensions/foo/index.ts"])).toEqual(["foo"]);
		expect(compactPathLabels(["/p/.pi/extensions/foo/index.ts", "/p/.pi/extensions/bar/index.ts"])).toEqual(["foo", "bar"]);
	});

	test("keeps more segments when the leaf name collides", () => {
		expect(compactPathLabels(["/p/.pi/extensions/a/thing.ts", "/p/.pi/extensions/b/thing.ts"])).toEqual([
			"a/thing.ts",
			"b/thing.ts",
		]);
	});
});

describe("labelFromSourceInfo", () => {
	test("derives a package label from the source path", () => {
		expect(
			labelFromSourceInfo({
				path: "/x/npm/node_modules/pi-btw/extensions/btw.ts",
				source: "npm:pi-btw",
				scope: "user",
				origin: "package",
				baseDir: "/x/npm/node_modules/pi-btw",
			}),
		).toBe("pi-btw:btw.ts");
	});

	test("keeps the colon of an empty package entry", () => {
		expect(
			labelFromSourceInfo({
				path: "/x/npm/node_modules/@s/pi-extension",
				source: "npm:@s/pi-extension",
				scope: "user",
				origin: "package",
				baseDir: "/x/npm/node_modules/@s/pi-extension",
			}),
		).toBe("@s/pi-extension:");
	});

	test("falls back to the path suffix for a local extension", () => {
		expect(
			labelFromSourceInfo({ path: "/home/me/.pi/agent/extensions/foo/index.ts", source: "/home/me/.pi/agent/extensions/foo/index.ts", scope: "user", origin: "top-level" }),
		).toBe("foo");
	});

	test("ignores pi's own built-ins, which pi keeps out of its startup list", () => {
		expect(labelFromSourceInfo({ path: "builtin:llama.cpp", source: "builtin", scope: "temporary", origin: "top-level" })).toBeUndefined();
		expect(labelFromSourceInfo({ path: "<temporary:acp>", source: "temporary", scope: "temporary", origin: "top-level" })).toBeUndefined();
	});

	test("ignores git sources and missing paths", () => {
		expect(labelFromSourceInfo({ path: "/x/foo.ts", source: "git:github.com/a/b", scope: "user", origin: "package" })).toBeUndefined();
		expect(labelFromSourceInfo(undefined)).toBeUndefined();
		expect(labelFromSourceInfo({ path: "", source: "npm:x", scope: "user", origin: "package" })).toBeUndefined();
	});
});

describe("collectResources", () => {
	const settings = {
		packages: ["npm:pi-btw", "npm:@scope/tool@2.0.0", "npm:ghost"],
		extensions: ["/opt/pi/local-thin.ts"],
	} as unknown as Settings;

	test("lists packages as pkg:entry and keeps the thinking level", async () => {
		const agentDir = tempDir();
		const cwd = tempDir();
		writeManifest(agentDir, "pi-btw", ["./extensions/btw.ts"]);
		writeManifest(agentDir, "@scope/tool", ["./dist/index.ts"]);

		const resources = await collectResources({
			cwd,
			agentDir,
			settings,
			model: { id: "claude-sonnet-4-5", provider: "anthropic", name: "Claude Sonnet 4.5" },
			thinking: "High",
			commands: [{ name: "btw:ask", source: "extension" }] as never,
		});

		expect(resources.extensions).toEqual([
			"@scope/tool:dist",
			"ghost",
			"local-thin.ts",
			"pi-btw:btw.ts",
		]);
		expect(resources.thinking).toBe("high");
		expect(resources.model).toBe("Claude Sonnet 4.5");
		expect(resources.version).toBe(await getPiVersion());
	});

	test("falls back to the bare package name when no manifest exists", async () => {
		const resources = await collectResources({
			cwd: tempDir(),
			agentDir: tempDir(),
			settings: { packages: ["npm:missing"] } as unknown as Settings,
		});
		expect(resources.extensions).toEqual(["missing"]);
	});

	test("a directory entry resolves to the file pi actually loads", async () => {
		const agentDir = tempDir();
		const cwd = tempDir();
		writeManifest(agentDir, "pi-starline", ["./extensions"]);
		const shipped = join(agentDir, "npm", "node_modules", "pi-starline", "extensions", "starline");
		mkdirSync(shipped, { recursive: true });
		writeFileSync(join(shipped, "index.ts"), "");
		writeManifest(agentDir, "pi-root", ["./"]);

		const resources = await collectResources({
			cwd,
			agentDir,
			settings: { packages: ["npm:pi-starline", "npm:pi-root"] } as unknown as Settings,
		});
		// `pi-starline` ships `./extensions`, so pi prints `pi-starline:starline`;
		// a package-root entry keeps its colon, exactly like pi's startup list.
		expect(resources.extensions).toEqual(["pi-root:", "pi-starline:starline"]);
	});

	test("several commands of one extension add one label, never the command names", async () => {
		const agentDir = tempDir();
		const cwd = tempDir();
		writeManifest(agentDir, "billion-context", ["./dist/agent/billion-context.js"]);
		const entry = join(agentDir, "npm", "node_modules", "billion-context", "dist", "agent", "billion-context.js");
		mkdirSync(join(agentDir, "npm", "node_modules", "billion-context", "dist", "agent"), { recursive: true });
		writeFileSync(entry, "");
		const sourceInfo = {
			path: entry,
			source: "npm:billion-context",
			scope: "user" as const,
			origin: "package" as const,
			baseDir: join(agentDir, "npm", "node_modules", "billion-context"),
		};
		const resources = await collectResources({
			cwd,
			agentDir,
			settings: { packages: ["npm:billion-context"] } as unknown as Settings,
			commands: [
				{ name: "acp", source: "extension", sourceInfo },
				{ name: "acp-cache", source: "extension", sourceInfo },
			],
		});
		// pi lists extensions, not the slash commands they register, so the panel
		// must not grow `acp` / `acp-cache` next to `billion-context:…`.
		expect(resources.extensions).toEqual(["billion-context:dist/agent/billion-context.js"]);
	});

	test("a command-only extension is labelled by its path, not by the command name", async () => {
		const cwd = tempDir();
		const entry = join(cwd, ".pi", "extensions", "oddity", "index.ts");
		const resources = await collectResources({
			cwd,
			agentDir: tempDir(),
			settings: {},
			commands: [
				{
					name: "odd",
					source: "extension",
					sourceInfo: { path: entry, source: entry, scope: "project", origin: "top-level" },
				},
			],
		});
		expect(resources.extensions).toEqual(["oddity"]);
	});

	test("a built-in command never becomes an extension row", async () => {
		const cwd = tempDir();
		const resources = await collectResources({
			cwd,
			agentDir: tempDir(),
			settings: {},
			commands: [
				{
					name: "llama",
					source: "extension",
					sourceInfo: { path: "builtin:llama.cpp", source: "builtin", scope: "temporary", origin: "top-level" },
				},
			],
		});
		expect(resources.extensions).toEqual([]);
	});

	test("reports unknown thinking/model without throwing", async () => {
		const resources = await collectResources({ cwd: tempDir(), agentDir: tempDir(), settings: {} });
		expect(resources.thinking).toBe("unknown");
		expect(resources.model).toBe("unknown");
		expect(resources.context).toEqual([]);
	});
});
