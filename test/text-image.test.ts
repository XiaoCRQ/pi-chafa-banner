import { describe, expect, test } from "bun:test";
import {
	isImageLine,
	padVisible,
	stripAnsi,
	truncateToWidth,
	visibleWidth,
} from "../src/text.ts";

/** A kitty root-frame sequence, shaped exactly like pi-tui's `encodeKitty` output. */
const SEQ = `\x1b_Ga=T,f=100,q=2,C=1,c=44,r=22,i=7;${"A".repeat(200)}\x1b\\`;
const ITERM2 = `\x1b]1337;File=inline=1;width=44px:${"B".repeat(64)}\x07`;

describe("text: APC handling", () => {
	test("a terminated kitty sequence is zero columns wide", () => {
		expect(visibleWidth(SEQ)).toBe(0);
	});

	test("padding before a sequence still counts", () => {
		expect(visibleWidth(`    ${SEQ}`)).toBe(4);
	});

	test("truncateToWidth leaves image lines byte-identical", () => {
		expect(truncateToWidth(SEQ, 60, "")).toBe(SEQ);
		expect(truncateToWidth(SEQ, 60)).toBe(SEQ);
		expect(truncateToWidth(SEQ, 60, "...", true)).toBe(SEQ);
	});

	test("stripAnsi consumes the whole APC sequence", () => {
		expect(stripAnsi(SEQ)).toBe("");
		expect(stripAnsi(`  ${SEQ}`)).toBe("  ");
	});

	test("an unterminated APC keeps its payload visible, like pi-tui", () => {
		// pi-tui's ansiCodeLength returns 0 for an unterminated APC, so only the
		// ESC byte is dropped and the remaining payload counts as text.
		const open = `\x1b_Ga=T,r=22;${"A".repeat(10)}`;
		expect(visibleWidth(open)).toBe(21);
		expect(isImageLine(open)).toBe(true);
	});
});

describe("text: isImageLine", () => {
	test("matches kitty and iTerm2 payloads at the start and mid-line", () => {
		expect(isImageLine(SEQ)).toBe(true);
		expect(isImageLine(`  ${SEQ}`)).toBe(true);
		expect(isImageLine(`abc${SEQ}`)).toBe(true);
		expect(isImageLine(ITERM2)).toBe(true);
		expect(isImageLine(`  ${ITERM2}`)).toBe(true);
	});

	test("rejects ordinary styled text", () => {
		expect(isImageLine("")).toBe(false);
		expect(isImageLine("\x1b[31mhello\x1b[0m")).toBe(false);
		expect(isImageLine("G=plain text")).toBe(false);
	});
});

describe("text: image lines are never padded", () => {
	test("padVisible passes image lines through", () => {
		expect(padVisible(SEQ, 40)).toBe(SEQ);
		expect(padVisible(SEQ, 4)).toBe(SEQ);
	});

	test("empty strings still pad to the full width", () => {
		expect(padVisible("", 40)).toBe(" ".repeat(40));
	});
});
