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
	extensionEntrySuffix,
	extensionLabel,
	getPiVersion,
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

describe("extensionEntrySuffix", () => {
	test("drops ./, extensions/ and index/main files", () => {
		expect(extensionEntrySuffix("./src/index.ts")).toBe("src");
		expect(extensionEntrySuffix("./dist/index.ts")).toBe("dist");
		expect(extensionEntrySuffix("./extensions/btw.ts")).toBe("btw.ts");
		expect(extensionEntrySuffix("extensions/workflow.ts")).toBe("workflow.ts");
		expect(extensionEntrySuffix("./dist/agent/billion-context.js")).toBe("dist/agent/billion-context.js");
		expect(extensionEntrySuffix("./")).toBe("");
		expect(extensionEntrySuffix("./index.ts")).toBe("");
	});
});

describe("extensionLabel", () => {
	// The exact shapes from the machine this was written for.
	test("renders the installed packages as pkg:entry", () => {
		const cases: Array<[string, string, string]> = [
			["@graelo/pi-vim", "./src/index.ts", "@graelo/pi-vim:src"],
			["@juicesharp/rpiv-ask-user-question", "./index.ts", "@juicesharp/rpiv-ask-user-question"],
			["@narumitw/pi-usage", "./dist/index.ts", "@narumitw/pi-usage:dist"],
			["@plannotator/pi-extension", "./", "@plannotator/pi-extension"],
			["@quintinshaw/pi-dynamic-workflows", "extensions/workflow.ts", "@quintinshaw/pi-dynamic-workflows:workflow.ts"],
			["billion-context", "./dist/agent/billion-context.js", "billion-context:dist/agent/billion-context.js"],
			["pi-btw", "./extensions/btw.ts", "pi-btw:btw.ts"],
			["pi-starline", "./extensions", "pi-starline:starline"],
			["pi-web-access", "./dist", "pi-web-access:dist"],
		];
		for (const [name, entry, expected] of cases) expect(extensionLabel(name, entry)).toBe(expected);
	});

	test("packageShortName drops the scope and the pi- prefix", () => {
		expect(packageShortName("pi-btw")).toBe("btw");
		expect(packageShortName("@scope/pi-thing")).toBe("thing");
		expect(packageShortName("@scope/plain")).toBe("plain");
		expect(packageShortName("pi-")).toBe("pi-");
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
			"local-thin",
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

	test("reports unknown thinking/model without throwing", async () => {
		const resources = await collectResources({ cwd: tempDir(), agentDir: tempDir(), settings: {} });
		expect(resources.thinking).toBe("unknown");
		expect(resources.model).toBe("unknown");
		expect(resources.context).toEqual([]);
	});
});
