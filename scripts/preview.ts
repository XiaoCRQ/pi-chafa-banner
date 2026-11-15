#!/usr/bin/env bun
/**
 * Standalone terminal preview for the splash — no pi process, no TUI, no model.
 *
 * Everything the real header does (frame pipeline, layout, theming, degradation)
 * runs here; only `TUI` and `Theme` are stubbed. This is the fast loop for
 * tuning the art and the box layout without launching pi.
 *
 *   bun run scripts/preview.ts                       # one static frame, 100 cols
 *   bun run scripts/preview.ts --static --width 100  # CI smoke test
 *   bun run scripts/preview.ts --width 60            # narrow (stacked) layout
 *   bun run scripts/preview.ts --frames 5            # print 5 animation frames
 *   bun run scripts/preview.ts --anim --fps 12       # loop in place
 *   bun run scripts/preview.ts --size 30x15          # smaller chafa canvas
 *   bun run scripts/preview.ts --no-frames           # placeholder card only
 *   bun run scripts/preview.ts --plain               # no colors (diffable)
 *   bun run scripts/preview.ts --static --image      # native kitty image band
 *   bun run scripts/preview.ts --config /tmp/tweak.json --static
 *   PI_IMAGE_PROTOCOL=kitty bun run scripts/preview.ts --static --image --real-kitty
 *   PI_IMAGE_PROTOCOL=kitty bun run scripts/preview.ts --static   # --image implied
 *
 * Art goes to stdout, diagnostics to stderr, so `... > preview.txt` is safe.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Banner } from "../src/banner.ts";
import {
	applySourceSize,
	clamp,
	DEFAULTS,
	formatSize,
	LIMITS,
	loadConfig,
	parseHexColor,
	parseSize,
	THEME_PRESETS,
	THEME_ROLES,
	type BannerConfig,
	type RateSetting,
	type ThemePreset,
	type ThemeRole,
} from "../src/config.ts";
import { FrameError, loadFrames, preflight, type FrameSet } from "../src/frames.ts";
import { argsDigest, parseChafaArgs } from "../src/pipeline/args.ts";
import { probeSourceSize } from "../src/pipeline/process.ts";
import { describeTiming } from "../src/pipeline/timing.ts";
import { visibleWidth } from "../src/text.ts";
import { collectResources, emptyResources, type BannerResources } from "../src/resources.ts";
import type { Theme, TUI } from "@earendil-works/pi-coding-agent";

interface Args {
	/** Simulated terminal width in columns. */
	width: number;
	/** Simulated terminal height in rows (used for short-terminal cropping). */
	rows: number;
	/** chafa canvas, e.g. 44x22. */
	size?: string;
	/** Explicit gif override. */
	gif?: string;
	/** How many animation frames to print (gallery mode). */
	frames: number;
	/** Whether --frames was given explicitly (caps --anim). */
	framesGiven: boolean;
	fps?: RateSetting;
	/** Render one frame and never animate. */
	static: boolean;
	/** Loop in place until Ctrl-C (or --frames iterations). */
	anim: boolean;
	/** Build/load real chafa frames. */
	useFrames: boolean;
	plain: boolean;
	colorMode: "truecolor" | "256color";
	/** Use the real project resources instead of deterministic stubs. */
	realResources: boolean;
	/** First animation frame to show. */
	frame: number;
	/** Extra chafa flags, overriding `image.chafa` from the config file. */
	chafa?: string;
	/** Explicit config file. */
	config?: string;
	/** `--theme`: palette preset override. */
	theme?: ThemePreset;
	/** `--color role=#hex`: per-role colour overrides. */
	colors: Partial<Record<ThemeRole, string>>;
}

const USAGE = `usage: bun run scripts/preview.ts [flags]

  --static            render a single frame, no animation timer (default output)
  --frames N          print N animation frames then exit
  --fps N|auto        animation rate: a fixed fps, or "auto" (default) = gif timing
  --size WxH          chafa canvas size (default ${formatSize(DEFAULTS.size)})
  --width COLS        simulated terminal width (default $COLUMNS or 100)
  --anim              loop frames in place until Ctrl-C
  --gif PATH          gif to preview (default: pi-chafa-banner.json / bundled gif)
  --config PATH       read configuration from PATH instead of <repo>/pi-chafa-banner.json
  --frame N           first animation frame
  --rows N            simulated terminal height (default $LINES or 40)
  --no-frames         skip chafa and show the placeholder/degraded card
  --real-resources    scan the current machine instead of stub resources
  --plain             disable colors
  --chafa "ARGS"      extra chafa flags (same syntax as image.chafa)
  --theme NAME        palette preset: tokyonight (default) | pi
  --color ROLE=#HEX   override one theme role: windowTitle|sectionTitle|border|content
  --256               render with the 256-color palette
  -h, --help          this text`;

/**
 * `--config PATH` reads that exact file; otherwise the package's own
 * `pi-chafa-banner.json` (or built-in defaults when it does not exist).
 */
function loadJsonConfig(path: string | undefined): BannerConfig {
	if (!path) return loadConfig();
	const absolute = resolve(path);
	return loadConfig({
		root: dirname(absolute),
		read: (target) => (target === join(dirname(absolute), "pi-chafa-banner.json") ? readFileSync(absolute, "utf8") : undefined),
	});
}

function positiveInt(raw: string | undefined, fallback: number): number {
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function parseArgs(argv: string[]): Args {
	const envCols = Number(process.env.COLUMNS);
	const envRows = Number(process.env.LINES);
	const args: Args = {
		width: envCols > 0 ? Math.floor(envCols) : 100,
		rows: envRows > 0 ? Math.floor(envRows) : 40,
		frames: 1,
		framesGiven: false,
		static: false,
		anim: false,
		useFrames: true,
		plain: false,
		colorMode: "truecolor",
		realResources: false,
		frame: 0,
		colors: {},
	};

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		switch (arg) {
			case "--width":
			case "--cols":
				args.width = positiveInt(argv[++i], args.width);
				break;
			case "--rows":
				args.rows = positiveInt(argv[++i], args.rows);
				break;
			case "--frames":
				args.frames = Math.max(1, positiveInt(argv[++i], args.frames));
				args.framesGiven = true;
				break;
			case "--fps": {
				const raw = argv[++i];
				if (raw === "auto") {
					args.fps = "auto";
					break;
				}
				const value = Number(raw);
				args.fps = clamp(Number.isFinite(value) ? value : 16, LIMITS.fps.min, LIMITS.fps.max);
				break;
			}
			case "--size":
				args.size = argv[++i];
				break;
			case "--config":
				args.config = argv[++i];
				break;
			case "--gif":
				args.gif = argv[++i];
				break;
			case "--frame":
				args.frame = Math.max(0, Number(argv[++i]) || 0);
				break;
			case "--static":
				args.static = true;
				args.anim = false;
				break;
			case "--anim":
				args.anim = true;
				args.static = false;
				break;
			case "--no-frames":
				args.useFrames = false;
				break;
			case "--real-resources":
				args.realResources = true;
				break;
			case "--plain":
				args.plain = true;
				break;
			case "--chafa": {
				args.chafa = argv[++i] ?? "";
				break;
			}
			case "--256":
				args.colorMode = "256color";
				break;
			case "--theme": {
				const raw = argv[++i] ?? "";
				if (THEME_PRESETS.includes(raw as ThemePreset)) args.theme = raw as ThemePreset;
				else console.warn(`preview: unknown theme ${raw} (expected ${THEME_PRESETS.join(" | ")})`);
				break;
			}
			case "--color": {
				const [role, value] = (argv[++i] ?? "").split("=");
				const hex = parseHexColor(value);
				if (!THEME_ROLES.includes(role as ThemeRole) || !hex) {
					console.warn(`preview: --color expects ROLE=#hex with ROLE one of ${THEME_ROLES.join(" | ")}`);
					break;
				}
				args.colors[role as ThemeRole] = hex;
				break;
			}
			case "--help":
			case "-h":
				console.log(USAGE);
				process.exit(0);
				break;
			default:
				console.warn(`preview: ignoring unknown argument ${arg}`);
		}
	}

	if (args.static) args.frames = 1;
	else if (args.framesGiven) args.static = false;
	if (args.anim && !args.framesGiven) args.frames = Number.POSITIVE_INFINITY;
	return args;
}

// ---------------------------------------------------------------------------
// stand-ins for pi's TUI/Theme (no pi runtime is loaded)
// ---------------------------------------------------------------------------

const RGB: Record<string, [number, number, number]> = {
	accent: [125, 190, 255],
	border: [90, 96, 112],
	borderAccent: [125, 190, 255],
	borderMuted: [72, 78, 92],
	dim: [120, 126, 140],
	muted: [150, 156, 170],
	text: [224, 228, 236],
	mdHeading: [255, 178, 108],
	mdLink: [125, 190, 255],
	mdCode: [168, 214, 160],
	toolTitle: [200, 160, 255],
	success: [126, 200, 130],
	warning: [230, 190, 100],
	error: [235, 120, 120],
};

function stubTheme(plain: boolean, colorMode: "truecolor" | "256color" = "truecolor"): Theme {
	const fg = (token: string, text: string) => {
		if (plain) return text;
		const [r, g, b] = RGB[token] ?? RGB.text;
		return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
	};
	return {
		fg: (token, text) => fg(token, text),
		bg: (_token, text) => text,
		bold: (text) => (plain ? text : `\x1b[1m${text}\x1b[22m`),
		italic: (text) => text,
		underline: (text) => text,
		getColorMode: () => colorMode,
	};
}

const stubTerminal = { rows: 40, columns: 100 };
const stubTui: TUI = {
	// pi's real value; "inline" was a long-standing typo in this stub.
	mode: "regular",
	terminal: stubTerminal,
	requestRender: () => {},
} as unknown as TUI;

function stubResources(): BannerResources {
	return {
		...emptyResources(),
		version: "1.5.2",
		model: "anthropic/claude-sonnet-4-5",
		theme: "dark",
		context: ["AGENTS.md", "~/.pi/agent/AGENTS.md"],
		skills: ["btw", "workflow-authoring", "workflow-patterns"],
		themes: ["dark", "light"],
		extensions: ["pi-btw", "pi-dynamic-workflows", "pi-chafa-banner"],
	};
}

async function resolveResources(real: boolean): Promise<BannerResources> {
	if (!real) return stubResources();
	try {
		const scanned = await collectResources({
			cwd: process.cwd(),
			commands: [],
			settings: {},
			model: undefined,
			activeTheme: "dark",
			availableThemes: [],
		});
		return {
			...stubResources(),
			...scanned,
			version: scanned.version === "?.?.?" ? "1.5.2" : scanned.version,
			model: scanned.model && scanned.model !== "unknown" ? scanned.model : stubResources().model,
		};
	} catch {
		return stubResources();
	}
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

/** Clear + home, so --anim repaints in place instead of scrolling. */
const HOME_CLEAR = "\x1b[H\x1b[2J";

function printFrame(lines: readonly string[]): void {
	process.stdout.write(`${lines.join("\n")}\n`);
}

/** Contract checks a terminal cannot do for us: width, and rows vs. viewport. */
function checkLayout(lines: readonly string[], width: number, terminalRows: number): string[] {
	const problems: string[] = [];
	for (const [index, line] of lines.entries()) {
		if (visibleWidth(line) > width) problems.push(`line ${index} is ${visibleWidth(line)} wide, terminal is ${width}`);
	}
	if (lines.length > terminalRows) {
		problems.push(`${lines.length} rows do not fit a ${terminalRows}-row terminal`);
	}
	return problems;
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const config: BannerConfig = { ...loadJsonConfig(args.config), enabled: true };
	if (args.gif) config.gifPath = args.gif;
	if (args.size) {
		config.size = parseSize(args.size, config.size);
	}
	if (args.fps !== undefined) config.fps = args.fps;
	if (args.chafa !== undefined) config.chafaArgs = parseChafaArgs(args.chafa);
	if (args.theme) config.theme = { ...config.theme, preset: args.theme };
	if (Object.keys(args.colors).length > 0) config.theme = { ...config.theme, ...args.colors };
	if (args.static) config.static = true;
	if (!args.size && config.gifPath) {
		try {
			Object.assign(config, applySourceSize(config, await probeSourceSize(config.gifPath)));
		} catch {
			// Missing ffmpeg: the width-derived height is a fine fallback.
		}
	}

	stubTerminal.rows = args.rows;
	stubTerminal.columns = args.width;

	let frames: FrameSet | undefined;
	const status: string | undefined = undefined;

	if (args.useFrames) {
		const tools = await preflight();
		if (!tools.ok) {
			console.error(
				`preview: missing required tool${tools.missing.length > 1 ? "s" : ""}: ${tools.missing.join(", ")}\n` +
					"  chafa renders the frames; ffmpeg extracts them from the gif.\n" +
					"  install: apt install chafa ffmpeg   (macOS: brew install chafa ffmpeg)\n" +
					"  or run with --no-frames to preview the degraded layout.",
			);
			process.exit(2);
		}

		const started = Date.now();
		try {
			frames = await loadFrames(config, args.colorMode, {});
			console.error(
				`preview: ${frames.frames.length}/${frames.totalFrames} frames @ ${frames.width}x${frames.height} ${frames.colorMode}` +
					` stride=${frames.stride}${frames.fromCache ? " (cache)" : " (fresh)"} in ${Date.now() - started}ms`,
			);
		} catch (error) {
			const message = error instanceof FrameError ? error.message : error instanceof Error ? error.message : String(error);
			console.error(`preview: cannot build frames — ${message}`);
			console.error(`  point image.path in ${config.source.path ?? "pi-chafa-banner.json"} at a readable gif`);
			process.exit(1);
		}
	}

	const banner = new Banner(stubTui, stubTheme(args.plain, args.colorMode), {
		config,
		resources: await resolveResources(args.realResources),
		frames,
		status,
	});

	const total = frames?.frames.length ?? 0;

	if (args.anim && total > 1) {
		// Same rule as the component: an explicit `fps` wins, otherwise each frame
		// uses the delay it carries (which is the gif's own timing).
		const fixed = typeof config.fps === "number" ? config.fps : undefined;
		const delays = frames?.delays ?? [];
		const delayFor = (index: number): number =>
			fixed !== undefined
				? Math.max(20, Math.round(1000 / fixed))
				: Math.max(20, Math.round(delays[index] ?? 100));
		const iterations = Number.isFinite(args.frames) ? Math.max(1, args.frames) : Number.POSITIVE_INFINITY;
		const restore = () => {
			process.stdout.write("\x1b[?25h\n");
		};
		process.on("SIGINT", () => {
			restore();
			process.exit(0);
		});
		process.stdout.write("\x1b[?25l");
		let index = args.frame;
		for (let i = 0; i < iterations; i++) {
			banner.setFrameIndex(index);
			process.stdout.write(HOME_CLEAR);
			printFrame(banner.render(args.width));
			await Bun.sleep(delayFor(index));
			index = (index + 1) % total;
		}
		restore();
		banner.dispose();
		const label =
			fixed !== undefined
				? `${fixed} fps`
				: `${describeTiming(delays)} (gif timing)`;
		console.error(
			`preview: played ${Number.isFinite(iterations) ? iterations : "∞"} frames at ${label}, width ${args.width}`,
		);
		return;
	}

	const count = Number.isFinite(args.frames) ? Math.max(1, args.frames) : 1;
	for (let i = 0; i < count; i++) {
		banner.setFrameIndex(args.frame + i);
		if (i > 0) process.stdout.write("\n");
		const lines = banner.render(args.width);
		printFrame(lines);
		const problems = checkLayout(lines, args.width, args.rows);
		if (problems.length > 0) {
			console.error(`preview: layout check failed\n  ${problems.join("\n  ")}`);
			process.exitCode = 1;
		}
	}
	console.error(
		`preview: ${count === 1 ? "1 frame" : `${count} frames`}, width ${args.width}, ` +
			`${args.static ? "static" : `anim ${typeof config.fps === "number" ? `${config.fps} fps` : "native"}`}, size ${formatSize(config.size)}` +
			(frames ? `, frame set ${frames.frames.length}/${frames.totalFrames}` : ", placeholder"),
	);
	banner.dispose();
}

await main();
