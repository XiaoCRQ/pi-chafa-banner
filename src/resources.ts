/**
 * Startup resource inventory for the right-hand panel.
 *
 * Sources, in order of reliability:
 *   - pi.getCommands()  -> skills ("skill:<name>") and extensions
 *   - pi.getSettings()  -> configured packages / extension paths / theme list
 *   - before_agent_start event -> already-loaded context files and skills
 *   - filesystem        -> AGENTS.md / CLAUDE.md / APPEND_SYSTEM.md, theme and
 *                          extension directories (in case nothing was loaded yet)
 *
 * This module never throws: a broken settings file or unreadable directory just
 * means a shorter list.
 */

import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { Settings, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { piAgentDir } from "./config.ts";

export interface BannerResources {
	version: string;
	model: string;
	theme: string;
	context: string[];
	skills: string[];
	themes: string[];
	extensions: string[];
}

export interface ResourceInput {
	cwd: string;
	commands?: readonly SlashCommandInfo[];
	settings?: Settings;
	agentDir?: string;
	model?: { id: string; provider: string; name?: string };
	activeTheme?: string;
	availableThemes?: readonly string[];
	/** Paths from `before_agent_start` (systemPromptOptions.contextFiles[].path). */
	contextFiles?: readonly string[];
	/** Names from `before_agent_start` (systemPromptOptions.skills[].name). */
	skills?: readonly string[];
	/** Name of our own slash command, excluded from the extensions list. */
	ownCommandName?: string;
}

const MAX_ITEMS_PER_SECTION = 48;
const CONTEXT_NAMES = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
const CONTEXT_SCAN_DEPTH = 6;

export function emptyResources(): BannerResources {
	return { version: "?.?.?", model: "unknown", theme: "default", context: [], skills: [], themes: [], extensions: [] };
}

// ---------------------------------------------------------------------------
// pi version
// ---------------------------------------------------------------------------

let cachedVersion: string | undefined;

/**
 * Locate pi's own package.json by walking up from the running entry point.
 * Avoids a static import of the host package so this module also loads in plain
 * bun (tests/preview), where the host alias does not exist.
 */
export function getPiVersion(env: NodeJS.ProcessEnv = process.env): string {
	if (cachedVersion) return cachedVersion;
	const starts = [process.argv[1], env.PI_PACKAGE_DIR].filter((value): value is string => Boolean(value));
	for (const start of starts) {
		let dir = isAbsolute(start) ? start : resolve(start);
		for (let depth = 0; depth < 8; depth++) {
			dir = dirname(dir);
			try {
				const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
					name?: string;
					version?: string;
				};
				if (manifest.name === "@earendil-works/pi-coding-agent" && manifest.version) {
					cachedVersion = manifest.version;
					return cachedVersion;
				}
			} catch {
				// no package.json here; keep walking
			}
			if (dirname(dir) === dir) break;
		}
	}
	cachedVersion = "?.?.?";
	return cachedVersion;
}

// ---------------------------------------------------------------------------
// labels
// ---------------------------------------------------------------------------

/** `pkg:extensions/foo/index.ts` -> `pkg`; `/a/b/foo.ts` -> `foo`; keeps @scopes. */
export function shortExtensionLabel(raw: string): string {
	let label = raw.trim().replace(/^\.\//, "");
	if (!label) return "extension";

	const colon = label.indexOf(":");
	if (colon > 0) {
		const head = label.slice(0, colon);
		if (head && !/^(file|https?|git|ssh)$/i.test(head) && !/^[a-z]$/i.test(head)) {
			// `packageName:relative/index` -> packageName
			return head;
		}
	}

	label = label.replace(/^~\/?/, "");
	label = label.replace(/\.(?:ts|js|mjs|cjs)$/i, "");
	const parts = label.split(/[\\/]/).filter(Boolean);
	if (parts.length === 0) return label || "extension";
	if (label.startsWith("/") || /^[a-z]:/i.test(label)) {
		return parts[parts.length - 1] ?? label;
	}
	if (parts[0]!.startsWith("@") && parts.length > 1) return `${parts[0]}/${parts[1]}`;
	return parts[0]!;
}

function uniqueSorted(values: Iterable<string>): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const value of values) {
		const trimmed = value.trim();
		if (!trimmed) continue;
		const key = trimmed.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(trimmed);
	}
	out.sort((a, b) => a.localeCompare(b));
	return out.slice(0, MAX_ITEMS_PER_SECTION);
}

function homeLabel(path: string): string {
	const home = homedir();
	const rel = relative(home, path);
	return rel && !rel.startsWith("..") ? `~/${rel}` : path;
}

// ---------------------------------------------------------------------------
// filesystem scans
// ---------------------------------------------------------------------------

/** AGENTS.md / CLAUDE.md in cwd and ancestors, plus APPEND_SYSTEM.md drop-ins. */
export function scanContextFiles(cwd: string, agentDir: string): string[] {
	const found: string[] = [];
	for (const name of ["APPEND_SYSTEM.md"]) {
		const agentFile = join(agentDir, name);
		if (existsSync(agentFile)) found.push(homeLabel(agentFile));
		const projectFile = join(cwd, ".pi", name);
		if (existsSync(projectFile)) found.push(`.pi/${name}`);
	}

	let dir = resolve(cwd);
	for (let depth = 0; depth < CONTEXT_SCAN_DEPTH; depth++) {
		for (const name of CONTEXT_NAMES) {
			const file = join(dir, name);
			if (!existsSync(file)) continue;
			found.push(depth === 0 ? name : relative(cwd, file));
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return found;
}

async function listDirNames(dir: string): Promise<string[]> {
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		return entries.map((entry) => entry.name);
	} catch {
		return [];
	}
}

async function scanSkillDir(dir: string): Promise<string[]> {
	return (await listDirNames(dir)).filter((name) => !name.startsWith(".") && existsSync(join(dir, name, "SKILL.md")));
}

async function scanThemes(dir: string): Promise<string[]> {
	return (await listDirNames(dir))
		.filter((name) => /\.json$/i.test(name) && !name.startsWith("."))
		.map((name) => name.replace(/\.json$/i, ""));
}

// ---------------------------------------------------------------------------
// collector
// ---------------------------------------------------------------------------

function fromCommands(commands: readonly SlashCommandInfo[] | undefined, source: "skill" | "extension"): string[] {
	if (!commands) return [];
	return commands
		.filter((command) => command.source === source)
		.map((command) => (source === "skill" ? command.name.replace(/^skill:/, "") : command.name));
}

/** Collect everything, never throw. */
export async function collectResources(input: ResourceInput): Promise<BannerResources> {
	const base = emptyResources();
	try {
		const agentDir = input.agentDir ?? piAgentDir();
		const cwd = input.cwd || process.cwd();
		const commands = input.commands;
		const settings = input.settings ?? {};
		const own = input.ownCommandName ?? "splash";

		const skills = [
			...fromCommands(commands, "skill"),
			...(input.skills ?? []),
			...(await scanSkillDir(join(cwd, ".pi", "skills"))),
			...(await scanSkillDir(join(agentDir, "skills"))),
		];

		const extensionLabels: string[] = [
			...fromCommands(commands, "extension").filter((name) => name !== own),
			...(settings.extensions ?? []).map(shortExtensionLabel),
		];
		for (const pkg of settings.packages ?? []) {
			if (typeof pkg === "string") {
				extensionLabels.push(shortExtensionLabel(pkg));
				continue;
			}
			if (pkg?.source) extensionLabels.push(shortExtensionLabel(pkg.source));
		}
		for (const dir of [join(agentDir, "extensions"), join(cwd, ".pi", "extensions")]) {
			for (const name of await listDirNames(dir)) {
				if (name.startsWith(".")) continue;
				extensionLabels.push(shortExtensionLabel(name));
			}
		}

		const themeNames = [
			...(input.availableThemes ?? []),
			...(settings.themes ?? []).map(shortExtensionLabel),
			...(await scanThemes(join(agentDir, "themes"))),
			...(await scanThemes(join(cwd, ".pi", "themes"))),
		];

		const activeTheme = input.activeTheme ?? settings.theme ?? "default";
		const model = input.model
			? input.model.name && input.model.name !== input.model.id
				? `${input.model.name} · ${input.model.provider}/${input.model.id}`
				: `${input.model.provider}/${input.model.id}`
			: "unknown";

		return {
			version: getPiVersion(),
			model,
			theme: activeTheme,
			context: uniqueSorted([...scanContextFiles(cwd, agentDir), ...(input.contextFiles ?? [])]),
			skills: uniqueSorted(skills),
			themes: uniqueSorted(themeNames),
			extensions: uniqueSorted(extensionLabels),
		};
	} catch {
		return base;
	}
}
