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

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, posix, relative, resolve } from "node:path";
import type { Settings, SlashCommandInfo, SourceInfo } from "@earendil-works/pi-coding-agent";
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

/** Entry names a directory-style `pi.extensions` entry can resolve to. */
const ENTRY_FILES = ["index.ts", "index.js", "index.mjs", "index.cjs"];

/**
 * The files pi would actually load for one manifest entry: the file itself, the
 * `index.*` of a directory, or one entry per subdirectory (`pi-starline` ships
 * `./extensions`, whose real entry is `extensions/starline/index.ts`).
 */
function resolveEntryFiles(base: string, entry: string): string[] {
	const target = resolve(base, entry);
	let info: ReturnType<typeof statSync>;
	try {
		info = statSync(target);
	} catch {
		return [];
	}
	if (info.isFile()) return [target];
	if (!info.isDirectory()) return [];
	for (const name of ENTRY_FILES) {
		const file = join(target, name);
		if (existsSync(file)) return [file];
	}
	const out: string[] = [];
	let children: string[];
	try {
		children = readdirSync(target);
	} catch {
		return out;
	}
	for (const child of children) {
		if (child.startsWith(".") || child === "node_modules") continue;
		for (const name of ENTRY_FILES) {
			const file = join(target, child, name);
			if (existsSync(file)) {
				out.push(file);
				break;
			}
		}
	}
	return out;
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
 * `npm:pi-btw` + `./extensions/btw.ts` -> `pi-btw:btw.ts`, the label pi prints
 * in its own startup list (`getCompactExtensionLabel`). Rules, in order:
 * drop `./`, drop a leading `extensions/`, an `index.*` entry collapses to its
 * directory (`pi-web-access:dist`), the package root stays the bare name, and
 * anything else keeps its relative path (`billion-context:dist/agent/x.js`).
 * An empty entry keeps the colon (`@plannotator/pi-extension:`), exactly like
 * pi does, so both lists read the same.
 */
export function packageEntryLabel(name: string, entry: string | undefined): string {
	if (entry === undefined) return name;
	const packagePath = entry.trim().replace(/^\.\//, "").replace(/^extensions\//, "");
	const dir = posix.dirname(packagePath);
	if (posix.parse(packagePath).name === "index") return !dir || dir === "." ? name : `${name}:${dir}`;
	return `${name}:${packagePath}`;
}

/**
 * Local extensions are shortened to the shortest path suffix that stays unique
 * (`<agent>/extensions/foo/index.ts` -> `foo`), mirroring pi's
 * `getCompactNonPackageExtensionLabel` so the panel matches its startup list.
 */
export function compactPathLabels(paths: readonly string[]): string[] {
	const all = paths.map(displaySegments);
	return all.map((segments, index) => {
		for (let count = 1; count <= segments.length; count += 1) {
			const candidate = segments.slice(-count).join("/");
			const unique = all.every(
				(other, otherIndex) => otherIndex === index || other.slice(-count).join("/") !== candidate,
			);
			if (unique) return candidate;
		}
		return segments.join("/");
	});
}

/** Path segments pi would compare, with a trailing `index.*` dropped first. */
function displaySegments(path: string): string[] {
	const parts = homeLabel(path)
		.split(/[\\/]/)
		.filter((part) => part.length > 0 && part !== "~");
	const last = parts[parts.length - 1] ?? "";
	if (parts.length > 1 && /^index\.[cm]?[jt]s$/i.test(last)) parts.pop();
	return parts;
}

/** Built-in / in-process extensions are addressed by a non-filesystem path. */
const SYNTHETIC_PATH = /^(?:builtin:|<)/;

/**
 * Label for the extension that registered a command, derived from pi's
 * `SourceInfo` rather than the command name: several commands of one extension
 * (`btw:ask`, `acp`, `acp-cache`) must still read as that extension's own
 * label — pi's startup list shows extensions, not the commands they add.
 */
export function labelFromSourceInfo(info: SourceInfo | undefined): string | undefined {
	const target = info?.path?.trim();
	if (!target) return undefined;
	// pi gives its own extensions a synthetic path (`builtin:llama.cpp`,
	// `<temporary:…>`) and marks them `hidden`, so `getCompactExtensionLabels()`
	// never prints them. They are part of pi, not something the user installed.
	if (SYNTHETIC_PATH.test(target)) return undefined;
	const source = (info?.source ?? "").trim();
	if (source === "builtin" || source === "temporary") return undefined;
	if (source.startsWith("npm:")) {
		const name = source.slice(4).trim();
		if (!name) return undefined;
		const base = info?.baseDir?.trim();
		return base ? packageEntryLabel(name, relative(base, target)) : `${name}:`;
	}
	if (source.startsWith("git:")) return undefined;
	const [label] = compactPathLabels([target]);
	return label;
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
	// Providers return everything; the window decides what fits, so no cap here.
	return out;
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
		const localPaths: string[] = [];
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
				localPaths.push(spec);
				continue;
			}
			const root = roots.find((candidate) => existsSync(join(candidate, name, "package.json")));
			const entry = manifestEntry(root ? readManifest(join(root, name, "package.json")) : undefined);
			packageKeys.add(name.toLowerCase());
			packageKeys.add(packageShortName(name).toLowerCase());
			packageKeys.add((name.split("/").pop() ?? name).toLowerCase());
			const trimmed = (entry ?? "").trim();
			if (entry === undefined) {
				extensionLabels.push(name);
				continue;
			}
			// pi resolves the entry to a real file before shortening, and a bare
			// package-root entry keeps its colon (`@plannotator/pi-extension:`).
			if (!trimmed || trimmed === "./") {
				extensionLabels.push(`${name}:`);
				continue;
			}
			const base = root ? join(root, name) : undefined;
			const files = base ? resolveEntryFiles(base, trimmed) : [];
			if (!base || files.length === 0) {
				extensionLabels.push(packageEntryLabel(name, trimmed));
				continue;
			}
			for (const file of files) extensionLabels.push(packageEntryLabel(name, relative(base, file)));
		}

		for (const dir of [join(agentDir, "extensions"), join(cwd, ".pi", "extensions")]) {
			for (const name of await listDirNames(dir)) {
				if (name.startsWith(".") || packageKeys.has(name.toLowerCase())) continue;
				const base = join(dir, name);
				const entry = manifestEntry(readManifest(join(base, "package.json")));
				// pi shortens the entry file the loader really runs, so an extension
				// directory reads as `foo` and its `dist/index.js` as `foo/dist`.
				localPaths.push(entry === undefined ? join(base, "index.ts") : resolve(base, entry));
			}
		}

		for (const raw of settings.extensions ?? []) localPaths.push(raw);
		extensionLabels.push(...compactPathLabels(localPaths));

		// Commands are the fallback for extensions that are neither a configured
		// package nor a directory. The label comes from the command's source path,
		// never from the command name: `acp` and `acp-cache` both belong to
		// `billion-context`, and pi's list shows the extension once.
		const covered = new Set<string>();
		for (const label of extensionLabels) {
			const head = label.split(":")[0] ?? "";
			covered.add(head.toLowerCase());
			covered.add(packageShortName(head).toLowerCase());
		}
		for (const command of commands ?? []) {
			if (command.source !== "extension") continue;
			const label = labelFromSourceInfo(command.sourceInfo);
			if (!label) continue;
			const head = label.split(":")[0] ?? label;
			if (head === own || covered.has(head.toLowerCase()) || covered.has(packageShortName(head).toLowerCase())) continue;
			extensionLabels.push(label);
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
