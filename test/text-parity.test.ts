/**
 * Parity probes against pi-tui's *real* implementation.
 *
 * Invariant 1 says `src/text.ts` must measure widths exactly like
 * `@earendil-works/pi-tui` — pi's renderer trusts `visibleWidth()` and clamps
 * lines with `truncateToWidth()`, so a silent drift here corrupts the whole
 * splash (and the editor below it). Hand-written constants cannot catch that:
 * these tests import pi-tui's own dist files and compare behaviour.
 *
 * The dist path is read from `PI_TUI_DIST` and defaults to the global pi
 * install; when it is absent (CI, other machines) the whole suite skips instead
 * of failing.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isImageLine, truncateToWidth, visibleWidth } from "../src/text.ts";

const distDir = process.env.PI_TUI_DIST ?? "/usr/lib/node_modules/pi/packages/tui/dist";
const utilsPath = join(distDir, "utils.js");
const imagePath = join(distDir, "terminal-image.js");
const available = existsSync(utilsPath) && existsSync(imagePath);

type PiUtils = {
	visibleWidth: (text: string) => number;
	truncateToWidth: (text: string, maxWidth: number, ellipsis?: string, pad?: boolean) => string;
};
type PiTerminalImage = { isImageLine: (line: string) => boolean };

const utils = available ? ((await import(utilsPath)) as PiUtils) : undefined;
const terminalImage = available ? ((await import(imagePath)) as PiTerminalImage) : undefined;

/** Mixed samples: plain, CJK, RGI emoji, VS16, ZWJ, ANSI, kitty/OSC sequences. */
const SAMPLES = [
	"",
	"plain ascii",
	"漢字テスト",
	"ａｂｃ wide latin",
	"e\u0301 combining",
	"🎉",
	"👍🏽",
	"👨‍👩‍👧‍👦",
	"🏳️‍🌈",
	"❤️",
	"\x1b[31mred\x1b[0m",
	"\x1b[1m\x1b[38;2;1;2;3mbold truecolor\x1b[0m",
	"\x1b_Ga=T,f=100,q=2,C=1,c=4,r=2,i=9;AAAA\x1b\\",
	"\x1b]1337;File=inline=1;AAAA\x07",
	"\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\",
	"\x1b_G incomplete apc",
	"╭─ RESOURCES ─╮",
	" tab\tseparated ",
	"⚠️ warning",
];

describe.skipIf(!available)("pi-tui parity", () => {
	test("visibleWidth matches pi-tui on mixed-width text", () => {
		expect(utils).toBeDefined();
		for (const sample of SAMPLES) {
			expect({ sample, width: visibleWidth(sample) }).toEqual({
				sample,
				width: utils!.visibleWidth(sample),
			});
		}
	});

	test("truncateToWidth produces the same visible width as pi-tui", () => {
		const long = [
			"plain ascii sentence that is long enough",
			"漢字テスト漢字テスト漢字テスト",
			"\x1b[31mred text that keeps being red for a while\x1b[0m",
			"👨‍👩‍👧‍👦".repeat(6),
			"⌚⌚⌚",
		];
		for (const sample of long) {
			for (const ellipsis of ["…", "..."]) {
				for (const width of [0, 1, 2, 4, 9, 16, 40]) {
					const mine = visibleWidth(truncateToWidth(sample, width, ellipsis));
					const theirs = utils!.visibleWidth(utils!.truncateToWidth(sample, width, ellipsis));
					expect({ sample, ellipsis, width, mine }).toEqual({ sample, ellipsis, width, mine: theirs });
					expect(mine).toBeLessThanOrEqual(width);
				}
			}
		}
	});

	test("isImageLine agrees on kitty, iterm2 and ordinary lines", () => {
		expect(terminalImage).toBeDefined();
		for (const sample of SAMPLES) {
			expect({ sample, image: isImageLine(sample) }).toEqual({
				sample,
				image: terminalImage!.isImageLine(sample),
			});
		}
	});
});
