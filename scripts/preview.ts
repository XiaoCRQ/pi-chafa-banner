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
 *   PI_IMAGE_PROTOCOL=kitty bun run scripts/preview.ts --static --image --real-kitty
 *   PI_IMAGE_PROTOCOL=kitty bun run scripts/preview.ts --static   # --image implied
 *
 * Art goes to stdout, diagnostics to stderr, so `... > preview.txt` is safe.
 */

import { Banner } from "../src/banner.ts";
import {
	clamp,
	DEFAULTS,
	formatSize,
	LIMITS,
	loadConfig,
	parseSize,
	type BannerConfig,
} from "../src/config.ts";
import { FrameError, loadFrames, missingToolsFor, preflight, type FrameSet } from "../src/frames.ts";
import { loadImageFrames, type ImageFrameSet } from "../src/images.ts";
import { imageBandBudget, parseKittyRows } from "../src/layout.ts";
import { isImageLine, visibleWidth } from "../src/text.ts";
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
	fps?: number;
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
	/** Native image band instead of chafa characters. */
	image: boolean;
	/** Grid cap for the image; defaults to --size / DEFAULTS.size. */
	imageCols?: number;
	imageRows?: number;
	/** Use pi-tui's real renderImage when it resolves (else the local encoder). */
	realKitty: boolean;
	/** Simulated PI_IMAGE_PROTOCOL value. */
	imageProto?: string;
}

const USAGE = `usage: bun run scripts/preview.ts [flags]

  --static            render a single frame, no animation timer (default output)
  --frames N          print N animation frames then exit
  --fps N             animation rate for --frames/--anim (1-${LIMITS.fps.max})
  --size WxH          chafa canvas size (default ${formatSize(DEFAULTS.size)})
  --width COLS        simulated terminal width (default $COLUMNS or 100)
  --anim              loop frames in place until Ctrl-C
  --gif PATH          gif to preview (default PI_BANNER_GIF / demo gif)
  --frame N           first animation frame
  --rows N            simulated terminal height (default $LINES or 40)
  --no-frames         skip chafa and show the placeholder/degraded card
  --real-resources    scan the current machine instead of stub resources
  --plain             disable colors
  --image             native kitty image band (requires ffmpeg)
  --image-cols N      image grid columns cap (default: --size width)
  --image-rows N      image grid rows cap (default: --size height)
  --real-kitty        use pi-tui's renderImage instead of the local encoder
  --image-proto P     simulate PI_IMAGE_PROTOCOL=kitty|iterm2|none
  --256               render with the 256-color palette
  -h, --help          this text`;

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
		image: false,
		realKitty: false,
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
				const raw = Number(argv[++i]);
				args.fps = clamp(Number.isFinite(raw) ? raw : DEFAULTS.fps, LIMITS.fps.min, LIMITS.fps.max);
				break;
			}
			case "--size":
				args.size = argv[++i];
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
			case "--image":
				args.image = true;
				break;
			case "--image-cols":
				args.imageCols = Math.max(1, positiveInt(argv[++i], 1));
				break;
			case "--image-rows":
				args.imageRows = Math.max(1, positiveInt(argv[++i], 1));
				break;
			case "--real-kitty":
				args.realKitty = true;
				break;
			case "--image-proto": {
				const value = argv[++i];
				args.imageProto = value;
				if (value) process.env.PI_IMAGE_PROTOCOL = value;
				break;
			}
			case "--256":
				args.colorMode = "256color";
				break;
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
	// `PI_IMAGE_PROTOCOL=kitty` means "this terminal speaks kitty", exactly what
	// pi's capability probe reports at runtime, so it must select the native image
	// path on its own — otherwise the env var silently does nothing.
	if (!args.image && process.env.PI_IMAGE_PROTOCOL === "kitty") args.image = true;
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

function stubTheme(plain: boolean): Theme {
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
		getColorMode: () => "truecolor",
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

/**
 * Structural self-check for the native image band. A terminal cannot verify
 * this for us: pi's contract is that the sequence line is followed by exactly
 * `r-1` empty strings, so that is what we assert here.
 */
function checkLayout(lines: readonly string[], width: number, terminalRows: number, images?: ImageFrameSet): string[] {
	const problems: string[] = [];
	const imageIndexes = lines.map((line, index) => (isImageLine(line) ? index : -1)).filter((index) => index >= 0);

	if (images) {
		if (imageIndexes.length > 1) problems.push(`expected exactly one image line, found ${imageIndexes.length}`);
		const start = imageIndexes[0];
		if (start !== undefined) {
			// A short terminal crops the band, so the transmitted `r=` is the source of truth here,
			// not `images.rows`. It must never exceed what the pipeline built.
			const band = bandRows(lines[start]!, images);
			if (band > images.rows) problems.push(`root frame says r=${band}, but only ${images.rows} rows were built`);
			for (let offset = 1; offset < band; offset++) {
				if (lines[start + offset] !== "") {
					problems.push(`reserved row ${start + offset} is not the empty string: ${JSON.stringify(lines[start + offset]?.slice(0, 20))}`);
				}
			}
			if (lines[start + band] !== "") problems.push("the row after the band is not an empty gap row");
		}
	}

	for (const [index, line] of lines.entries()) {
		if (visibleWidth(line) > width) problems.push(`line ${index} is ${visibleWidth(line)} wide, terminal is ${width}`);
	}
	if (lines.length > terminalRows) problems.push(`${lines.length} rows do not fit a ${terminalRows}-row terminal`);
	return problems;
}

/** Rows the band actually reserves: the cropped `r=` when present, else the built height. */
function bandRows(line: string, images: ImageFrameSet): number {
	return parseKittyRows(line) ?? images.rows;
}

/** Human/machine readable summary so `--image` is assertable without a TTY. */
function describeImageStructure(lines: readonly string[], images: ImageFrameSet): string {
	const start = lines.findIndex((line) => isImageLine(line));
	if (start < 0) {
		return `structure: no image line (placeholder card, ${lines.length} rows)`;
	}
	const line = lines[start]!;
	const band = bandRows(line, images);
	const reserved = lines.slice(start + 1, start + band).filter((entry) => entry === "").length;
	const prefix = line.slice(0, line.indexOf(";") + 1).replace(/\x1b/g, "ESC");
	return [
		`structure: image line at row ${start}`,
		`prefix=${prefix}`,
		`bytes=${line.length}`,
		`columns=${images.columns}`,
		`r=${band}/${images.rows}`,
		`reserved-empty-rows=${reserved}/${band - 1}`,
		`lower-rows=${lines.length - start - band - 1}`,
		`total-rows=${lines.length}`,
	].join(" ");
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const config: BannerConfig = { ...loadConfig(), enabled: true };
	if (args.gif) config.gifPath = args.gif;
	if (args.size) config.size = parseSize(args.size, config.size);
	if (args.fps !== undefined) config.fps = args.fps;
	if (args.static) config.static = true;

	stubTerminal.rows = args.rows;
	stubTerminal.columns = args.width;

	let frames: FrameSet | undefined;
	let images: ImageFrameSet | undefined;
	let status: string | undefined;

	if (args.image) {
		const tools = await preflight();
		const missing = missingToolsFor(tools, "kitty");
		if (missing.length > 0) {
			console.error(
				`preview: missing required tool${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}\n` +
					"  the native image path needs ffmpeg to extract and quantize the frames.",
			);
			process.exit(2);
		}
		const budget = imageBandBudget({
			cols: args.width,
			size: args.size ? parseSize(args.size, config.size) : config.size,
		});
		const maxColumns = args.imageCols ?? budget.maxColumns;
		const maxRows = args.imageRows ?? budget.maxRows;
		const started = Date.now();
		try {
			images = await loadImageFrames(config, { maxColumns, maxRows, payloadStub: !args.realKitty });
			console.error(
				`preview: image ${images.columns}x${images.rows}c ${images.pixelWidth}x${images.pixelHeight}px ` +
					`${images.frames.length}/${images.totalFrames}f gap ${images.gapMs}ms id=${images.imageId} ` +
					`${images.fromCache ? "(cache)" : "(fresh)"} in ${Date.now() - started}ms`,
			);
			if (args.realKitty) {
				const { loadKittyModule } = await import("../src/kitty.ts");
				const kitty = await loadKittyModule();
				if (!kitty) console.error("preview: pi-tui not resolvable here; using stub encoder");
			}
		} catch (error) {
			const message = error instanceof FrameError ? error.message : String(error);
			console.error(`preview: cannot build the image band — ${message}`);
			process.exit(1);
		}
	}

	if (args.useFrames && !args.image) {
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
			console.error("  set PI_BANNER_GIF=/path/to.gif or drop one at ~/.pi/agent/banner.gif");
			process.exit(1);
		}
	}

	const banner = new Banner(stubTui, stubTheme(args.plain), {
		config,
		resources: await resolveResources(args.realResources),
		frames,
		images,
		renderer: args.image ? "kitty" : "chars",
		status,
	});

	const total = args.image ? (images?.frames.length ?? 1) : (frames?.frames.length ?? 0);

	if (args.anim && total > 1) {
		const fps = args.fps ?? config.fps;
		const delayMs = Math.max(16, Math.round(1000 / Math.max(1, fps)));
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
			index = (index + 1) % total;
			await Bun.sleep(delayMs);
		}
		restore();
		banner.dispose();
		console.error(`preview: played ${Number.isFinite(iterations) ? iterations : "∞"} frames at ${fps} fps, width ${args.width}`);
		return;
	}

	const count = Number.isFinite(args.frames) ? Math.max(1, args.frames) : 1;
	for (let i = 0; i < count; i++) {
		banner.setFrameIndex(args.frame + i);
		if (i > 0) process.stdout.write("\n");
		const lines = banner.render(args.width);
		printFrame(lines);
		const problems = checkLayout(lines, args.width, args.rows, images);
		if (images) console.error(describeImageStructure(lines, images));
		if (problems.length > 0) {
			console.error(`preview: layout check failed\n  ${problems.join("\n  ")}`);
			process.exitCode = 1;
		}
	}
	console.error(
		`preview: ${count === 1 ? "1 frame" : `${count} frames`}, width ${args.width}, ` +
			`${args.static ? "static" : `anim ${args.fps ?? config.fps} fps`}, size ${formatSize(config.size)}` +
			(images
				? `, image ${images.frames.length}/${images.totalFrames}f at ${images.columns}x${images.rows}c`
				: frames
					? `, frame set ${frames.frames.length}/${frames.totalFrames}`
					: ", placeholder"),
	);
	banner.dispose();
}

await main();
