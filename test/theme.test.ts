import { describe, expect, test } from "bun:test";
import {
	foregroundCode,
	paintForeground,
	resolvePalette,
	rgbTo256,
	hexToRgb,
	infoBox,
	panel,
	plainPainter,
	resourcePanel,
	resourceSection,
	themePainter,
	type PaletteSettings,
} from "../src/layout.ts";
import { DEFAULT_FILE, parseHexColor, TOKYONIGHT_PALETTE } from "../src/config.ts";
import { validateSettings } from "../src/config/validate.ts";
import { visibleWidth } from "../src/text.ts";

/** Theme double that records which pi token each role fell back to. */
function recordingTheme(mode: "truecolor" | "256color" = "truecolor") {
	const seen: string[] = [];
	return {
		seen,
		theme: {
			fg: (token: string, text: string) => {
				seen.push(token);
				return text;
			},
			bold: (text: string) => text,
			getColorMode: () => mode,
		},
	};
}

describe("parseHexColor", () => {
	test("normalises three-digit hex", () => {
		expect(parseHexColor("#ABC")).toBe("#aabbcc");
		expect(parseHexColor(" #7AA2F7 ")).toBe("#7aa2f7");
	});

	test("rejects anything that is not a hex colour", () => {
		for (const bad of ["", "red", "7aa2f7", "#12", "#12345", "#gggggg", "rgb(1,2,3)"]) {
			expect(parseHexColor(bad)).toBeUndefined();
		}
	});
});

describe("config: theme group", () => {
	const validate = (theme: unknown) => validateSettings({ theme });
	const clean = (theme: unknown) => validate(theme).warnings.filter((warning) => warning.startsWith("theme."));

	test("missing group keeps the built-in tokyonight default", () => {
		const settings = validateSettings({});
		expect(settings.theme.preset).toBe("tokyonight");
		expect(settings.theme.windowTitle).toBeUndefined();
		expect(settings.warnings).toEqual([]);
	});

	test("accepts the tokyonight preset and normalises colours", () => {
		const settings = validate({
			preset: "tokyonight",
			windowTitle: "#ABC",
			sectionTitle: "#bb9af7",
			border: "#3b4261",
			content: "#A9B1D6",
		});
		expect(settings.theme).toEqual({
			preset: "tokyonight",
			windowTitle: "#aabbcc",
			sectionTitle: "#bb9af7",
			border: "#3b4261",
			content: "#a9b1d6",
		});
		expect(clean({ preset: "tokyonight" })).toEqual([]);
	});

	test("blank colours mean 'use the preset' without a warning", () => {
		const settings = validate({ windowTitle: "  ", border: "" });
		expect(settings.theme.windowTitle).toBeUndefined();
		expect(settings.theme.border).toBeUndefined();
		expect(clean({ windowTitle: "  " })).toEqual([]);
	});

	test("bad preset and bad colours warn and fall back per field", () => {
		const settings = validate({ preset: "solarized", border: "blue", content: 42 });
		expect(settings.theme.preset).toBe("tokyonight");
		expect(settings.theme.border).toBeUndefined();
		expect(settings.theme.content).toBeUndefined();
		const warnings = clean({ preset: "solarized", border: "blue", content: 42 }).join("\n");
		expect(warnings).toContain("theme.preset");
		expect(warnings).toContain("theme.border");
		expect(warnings).toContain("theme.content");
	});

	test("default config file carries the tokyonight preset", () => {
		expect(DEFAULT_FILE.theme.preset).toBe("tokyonight");
	});
});

describe("resolvePalette", () => {
	test("pi preset yields no pinned colours (theme tokens stay in charge)", () => {
		expect(resolvePalette({ preset: "pi" })).toEqual({});
		expect(resolvePalette(undefined)).toEqual({});
		expect(resolvePalette({ preset: "solarized" } as unknown as PaletteSettings)).toEqual({});
	});

	test("tokyonight fills every role — and is what a config-less install gets", () => {
		expect(resolvePalette({ preset: "tokyonight" })).toEqual({ ...TOKYONIGHT_PALETTE });
		expect(resolvePalette(DEFAULT_FILE.theme)).toEqual({ ...TOKYONIGHT_PALETTE });
	});

	test("explicit colours win over the preset", () => {
		const palette = resolvePalette({
			preset: "tokyonight",
			border: "#FF0000",
			content: "#0f0",
		});
		expect(palette.border).toBe("#ff0000");
		expect(palette.content).toBe("#00ff00");
		expect(palette.windowTitle).toBe(TOKYONIGHT_PALETTE.windowTitle);
	});
});

describe("ANSI conversion", () => {
	test("hexToRgb", () => {
		expect(hexToRgb("#7aa2f7")).toEqual([122, 162, 247]);
		expect(hexToRgb("nope")).toBeUndefined();
	});

	test("truecolor emits 24-bit SGR and resets the foreground", () => {
		expect(foregroundCode("#7aa2f7")).toBe("\x1b[38;2;122;162;247m");
		expect(paintForeground("#7aa2f7", "x")).toBe("\x1b[38;2;122;162;247mx\x1b[39m");
	});

	test("256color picks cube and grey-ramp entries", () => {
		expect(rgbTo256(255, 0, 0)).toBe(196); // 6x6x6 cube, pure red
		expect(rgbTo256(128, 128, 128)).toBe(244); // exact 24-step grey
		expect(paintForeground("#ff0000", "x", "256color")).toBe("\x1b[38;5;196mx\x1b[39m");
	});

	test("invalid hex is a no-op, not an exception", () => {
		expect(paintForeground("nope", "x")).toBe("x");
	});
});

describe("themePainter", () => {
	test("default palette delegates every role to pi's theme tokens", () => {
		const { seen, theme } = recordingTheme();
		const painter = themePainter(theme, { preset: "pi" });
		panel("RESOURCES", ["x"], 30, painter);
		resourceSection("Skills", ["btw"], 24, painter);
		infoBox("T", [{ label: "model", value: "x" }], 24, painter);
		expect(seen).toContain("borderMuted");
		expect(seen).toContain("mdHeading");
		expect(seen).toContain("muted");
		expect(seen).toContain("text");
	});

	test("tokyonight paints borders, window titles and section headings", () => {
		const { theme } = recordingTheme();
		const painter = themePainter(theme, { preset: "tokyonight" });
		const code = (hex: string) => foregroundCode(hex, "truecolor") as string;
		expect(panel("RESOURCES", [], 40, painter)[0]).toContain(code(TOKYONIGHT_PALETTE.windowTitle));
		expect(resourceSection("Skills", ["btw"], 24, painter)[0]).toContain(code(TOKYONIGHT_PALETTE.sectionTitle));
		expect(panel(undefined, ["body"], 20, painter)[0]).toContain(code(TOKYONIGHT_PALETTE.border));
	});

	test("one content colour covers values, labels and dim names", () => {
		const { theme } = recordingTheme();
		const painter = themePainter(theme, { content: "#c0caf5" });
		const expected = paintForeground("#c0caf5", "x");
		expect(painter.fg("text", "x")).toBe(expected);
		expect(painter.fg("muted", "x")).toBe(expected);
		expect(painter.fg("dim", "x")).toBe(expected);
	});

	test("256color mode is used for custom colours", () => {
		const { theme } = recordingTheme("256color");
		const painter = themePainter(theme, { border: "#ff0000" });
		expect(painter.fg("border", "x")).toBe("\x1b[38;5;196mx\x1b[39m");
	});

	test("widths survive the extra escape sequences", () => {
		const painter = themePainter(recordingTheme().theme, { preset: "tokyonight" });
		const sections = [{ title: "Context", names: ["AGENTS.md", "~/.pi/agent/AGENTS.md"] }];
		const panelLines = panel("RESOURCES", ["[Skills]", "  btw, workflow-patterns"], 34, painter);
		expect(panelLines.every((line) => visibleWidth(line) === 34)).toBe(true);
		const resourceLines = resourcePanel("RESOURCES", sections, 44, painter, 18);
		expect(resourceLines.every((line) => visibleWidth(line) === 44)).toBe(true);
		expect(plainPainter.fg("windowTitle", "x")).toBe("x");
	});
});
