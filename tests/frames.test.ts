/**
 * Frame-pipeline invariants that protect the splash from chafa's raw output:
 *
 *   - chafa prints terminal control sequences (hide cursor, clear screen,
 *     alternate screen) that must never reach pi's renderer, while SGR colors
 *     must survive;
 *   - every cached frame is exactly WxH so the banner's geometry is stable;
 *   - the cache key includes gif mtime and canvas size, so editing the gif or
 *     changing BANNER_SIZE never serves stale art.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { frameCachePath, gifHash, sanitizeFrame, stripChafaControl } from "../src/frames.ts";
import { visibleWidth } from "../src/text.ts";

describe("stripChafaControl", () => {
	test("removes cursor/clear/alternate-screen sequences", () => {
		const raw = [
			"\x1b[?25l", // hide cursor
			"\x1b[?1049h", // enter alternate screen
			"\x1b[2J", // clear screen
			"\x1b[0H", // cursor home
			"\x1b[12;3H", // cursor position
			"hello",
			"\r",
			"\x1b[?1049l",
			"\x1b[?25h",
		].join("");
		const cleaned = stripChafaControl(raw);
		expect(cleaned).toBe("hello");
		expect(cleaned).not.toContain("\x1b[?25");
		expect(cleaned).not.toContain("\x1b[2J");
		expect(cleaned).not.toContain("\r");
	});

	test("keeps SGR colors and resets", () => {
		const raw = "\x1b[38;2;255;0;0mred\x1b[0m \x1b[1;34mbold blue\x1b[22m";
		expect(stripChafaControl(raw)).toBe(raw);
	});
});

describe("sanitizeFrame", () => {
	test("pads every row to exactly the requested cell width", () => {
		const raw = ["abc", "\x1b[31mred\x1b[0m", "abcdefgh"].join("\n");
		const lines = sanitizeFrame(raw, 6, 3);
		expect(lines).toHaveLength(3);
		for (const line of lines) expect(visibleWidth(line)).toBe(6);
		// Truncation, not wrapping.
		expect(lines[2]).toContain("abcdef");
		expect(lines[2]).not.toContain("gh");
	});

	test("truncates long rows and strips control sequences from cells", () => {
		const lines = sanitizeFrame(`\x1b[?25l${"x".repeat(20)}\x1b[2J`, 4, 2);
		expect(lines).toHaveLength(2);
		expect(lines[0]).toBe("xxxx");
		expect(lines[1]).toBe("    ");
	});

	test("handles fewer rows than requested by padding with blanks", () => {
		const lines = sanitizeFrame("only one", 8, 4);
		expect(lines).toHaveLength(4);
		expect(lines[0]).toBe("only one");
		expect(lines.slice(1)).toEqual(["        ", "        ", "        "]);
	});
});

describe("frame cache key", () => {
	let root: string;
	let gif: string;
	let previousAgentDir: string | undefined;

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "pi-chafa-frames-"));
		gif = join(root, "banner.gif");
		await writeFile(gif, Buffer.from("GIF89a-fake-but-stable"));
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	});

	afterAll(async () => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(root, { recursive: true, force: true });
	});

	test("changes when the gif mtime changes", async () => {
		await utimes(gif, new Date(1_600_000_000), new Date(1_600_000_000));
		const before = await frameCachePath(gif, { width: 44, height: 22 }, "truecolor");
		const hashBefore = await gifHash(gif);

		await utimes(gif, new Date(1_600_000_100), new Date(1_600_000_100));
		const after = await frameCachePath(gif, { width: 44, height: 22 }, "truecolor");
		const hashAfter = await gifHash(gif);

		expect(after).not.toBe(before);
		expect(hashAfter).not.toBe(hashBefore);
	});

	test("changes when the canvas size changes", async () => {
		const small = await frameCachePath(gif, { width: 44, height: 22 }, "truecolor");
		const large = await frameCachePath(gif, { width: 60, height: 30 }, "truecolor");
		expect(large).not.toBe(small);
		expect(small).toContain("frames-44x22-truecolor.json");
		expect(large).toContain("frames-60x30-truecolor.json");
	});

	test("changes when the color mode changes", async () => {
		const full = await frameCachePath(gif, { width: 44, height: 22 }, "truecolor");
		const ansi256 = await frameCachePath(gif, { width: 44, height: 22 }, "256color");
		expect(ansi256).not.toBe(full);
		expect(ansi256).toContain("256color");
	});

	test("is stable for an unchanged gif", async () => {
		const first = await frameCachePath(gif, { width: 44, height: 22 }, "truecolor");
		const second = await frameCachePath(gif, { width: 44, height: 22 }, "truecolor");
		expect(second).toBe(first);
	});
});
