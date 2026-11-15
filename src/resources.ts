/**
 * Startup resource inventory for the right-hand panel.
 *
 * Sources, in order of reliability:
 *   - pi.getCommands()  -> skills ("skill:<name>") and extensions
 *   - pi.getSettings()  -> configured packages / extension paths
 *   - before_agent_start event -> already-loaded context files and skills
 *   - filesystem        -> AGENTS.md / CLAUDE.md / APPEND_SYSTEM.md, extension
 *                          directories and `npm:` manifests (in case nothing
 *                          was loaded yet)
 *
 * This module never throws: a broken settings file or unreadable directory just
 * means a shorter list.
 */

import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import type { Settings, SlashCommandInfo } from "@earendil-works/pi-coding-agent";
import { piAgentDir } from "./config.ts";
import { run } from "./pipeline/process.ts";

export interface BannerResources {
	version: string;
	model: string;
	thinking: string;
	context: string[];
	skills: string[];
	extensions: string[];
}

export interface ResourceInput {
	cwd: string;
	commands?: readonly SlashCommandInfo[];
	settings?: Settings;
	agentDir?: string;
	model?: { id: string; provider: string; name?: string };
	/** pi's current thinking level (`ctx.thinkingLevel` / `thinking_level_select`). */
	thinking?: string;
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
	return { version: "?.?.?", model: "unknown", thinking: "unknown", context: [], skills: [], extensions: [] };
}

// ---------------------------------------------------------------------------
// pi version
// ---------------------------------------------------------------------------

/** `pi -v` is spawned once per process; every refresh reuses the result. */
let piVersion: Promise<string> | undefined;

/**
 * The host's version, asked straight from `pi -v` (~150ms, cached). Spawning is
 * safe here: resource collection is async and never runs inside `render()`.
 * Any failure degrades to `?.?.?` instead of breaking the panel.
 */
export function getPiVersion(): Promise<string> {
	piVersion ??= run("pi", ["-v"], 4_000)
		.then(({ stdout }) => parsePiVersion(stdout))
		.catch(() => "?.?.?");
	return piVersion;
}

/** First `x.y.z` (prerelease suffix kept) in `pi -v` output; else `?.?.?`. */
export function parsePiVersion(stdout: string): string {
	const match = /\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.]+)?/.exec(stdout);
	return match?.[0] ?? "?.?.?";
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

/** `npm:@scope/pkg@1.2.3` -> `@scope/pkg`; anything that is not an npm spec -> undefined. */
export function packageNameFromSpec(spec: string): string | undefined {
	const trimmed = spec.trim();
	if (!/^npm:/i.test(trimmed)) return undefined;
	const rest = trimmed.slice(4).trim();
	if (!rest) return undefined;
	const at = rest.lastIndexOf("@");
	const name = (at > 0 ? rest.slice(0, at) : rest).trim();
	return name || undefined;
}

/** `@scope/pkg` -> `pkg`, `pi-btw` -> `btw`: the human short name of a package. */
export function packageShortName(name: string): string {
	const base = name.startsWith("@") ? (name.split("/")[1] ?? name) : name;
	const stripped = base.replace(/^pi-/, "");
	return stripped || base;
}

/**
 * Strip what carries no information once the package name is already printed:
 * `./`, a leading `extensions/`, a trailing `index.ts` / `main.js`, slashes.
 * `./src/index.ts` -> `src`, `./extensions/btw.ts` -> `btw.ts`.
 */
export function extensionEntrySuffix(entry: string): string {
	let value = entry
		.trim()
		.replace(/^\.\/?/, "")
		.replace(/\/+$/, "");
	if (!value) return "";
	value = value.replace(/^extensions(?:\/|$)/i, "").replace(/\/+$/, "");
	value = value.replace(/(?:^|\/)(?:index|main)\.(?:[cm]?[jt]s)$/i, "");
	return value.replace(/\/+$/, "");
}

/**
 * `pi-btw` + `./extensions/btw.ts` -> `pi-btw:btw.ts`. Entries at the package
 * root (`./`, `./index.ts`) need no suffix at all; a bare `./extensions`
 * degrades to the short package name.
 */
export function extensionLabel(name: string, entry: string): string {
	const cleaned = entry
		.trim()
		.replace(/^\.\/?/, "")
		.replace(/\/+$/, "");
	if (!cleaned) return name;
	if (/^extensions$/i.test(cleaned)) return `${name}:${packageShortName(name)}`;
	const suffix = extensionEntrySuffix(cleaned);
	return suffix ? `${name}:${suffix}` : name;
}

interface PackageManifest {
	name?: string;
	pi?: { extensions?: unknown };
}

function readManifest(file: string): PackageManifest | undefined {
	try {
		return JSON.parse(readFileSync(file, "utf8")) as PackageManifest;
	} catch {
		return undefined;
	}
}

/** First `pi.extensions` entry of an installed package, if any. */
function manifestEntry(manifest: PackageManifest | undefined): string | undefined {
	const list = manifest?.pi?.extensions;
	if (!Array.isArray(list)) return undefined;
	return list.find((value): value is string => typeof value === "string");
}

/** Where pi unpacks `npm:` packages: user scope first, then project scope. */
function packageRoots(agentDir: string, cwd: string): string[] {
	return [join(agentDir, "npm", "node_modules"), join(cwd, ".pi", "npm", "node_modules")];
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

		const extensionLabels: string[] = [];
		const roots = packageRoots(agentDir, cwd);

		// `npm:` packages carry their entry point in `pi.extensions`; show it as
		// `pkg:entry` so the panel says what actually got loaded. The same plugin
		// often also has a directory under `extensions/`, so remember the package
		// names and skip the duplicate directory entry below.
		const packageKeys = new Set<string>();
		for (const pkg of settings.packages ?? []) {
			const spec = typeof pkg === "string" ? pkg : pkg?.source;
			if (!spec) continue;
			const name = packageNameFromSpec(spec);
			if (!name) {
				extensionLabels.push(shortExtensionLabel(spec));
				continue;
			}
			const entry = roots.map((root) => manifestEntry(readManifest(join(root, name, "package.json")))).find(
				(value) => value !== undefined,
			);
			packageKeys.add(name.toLowerCase());
			packageKeys.add(packageShortName(name).toLowerCase());
			packageKeys.add((name.split("/").pop() ?? name).toLowerCase());
			extensionLabels.push(entry === undefined ? name : extensionLabel(name, entry));
		}

		for (const dir of [join(agentDir, "extensions"), join(cwd, ".pi", "extensions")]) {
			for (const name of await listDirNames(dir)) {
				if (name.startsWith(".") || packageKeys.has(name.toLowerCase())) continue;
				const manifest = readManifest(join(dir, name, "package.json"));
				const entry = manifestEntry(manifest);
				const pkgName = manifest?.name ?? name;
				extensionLabels.push(entry === undefined ? shortExtensionLabel(name) : extensionLabel(pkgName, entry));
			}
		}

		for (const raw of settings.extensions ?? []) extensionLabels.push(shortExtensionLabel(raw));

		// Command names are the fallback for extensions that are neither a
		// configured package nor a directory; `btw:ask` belongs to `pi-btw:btw.ts`.
		const covered = new Set<string>();
		for (const label of extensionLabels) {
			const head = label.split(":")[0] ?? "";
			covered.add(head.toLowerCase());
			covered.add(packageShortName(head).toLowerCase());
		}
		for (const name of fromCommands(commands, "extension")) {
			const base = name.split(":")[0] ?? name;
			if (base === own || covered.has(base.toLowerCase())) continue;
			extensionLabels.push(name);
		}

		// The human name when pi knows one, the canonical `provider/id` otherwise:
		// the info card appends the thinking level after it, so the model string
		// has to stay short enough to leave that suffix room.
		const model = input.model
			? input.model.name?.trim() || `${input.model.provider}/${input.model.id}`
			: "unknown";
		const thinking = (input.thinking ?? "").trim().toLowerCase() || "unknown";

		return {
			version: await getPiVersion(),
			model,
			thinking,
			context: uniqueSorted([...scanContextFiles(cwd, agentDir), ...(input.contextFiles ?? [])]),
			skills: uniqueSorted(skills),
			extensions: uniqueSorted(extensionLabels),
		};
	} catch {
		return base;
	}
}
