import { describe, expect, test } from "bun:test";
import { needsImageRebuild } from "../src/extension/session.ts";

describe("session: resize rebuild decision", () => {
	test("the first build is never a rebuild", () => {
		expect(needsImageRebuild(undefined, { maxColumns: 44, maxRows: 22 })).toBe(false);
	});

	test("the same shape is left alone", () => {
		expect(needsImageRebuild({ maxColumns: 44, maxRows: 22 }, { maxColumns: 44, maxRows: 22 })).toBe(false);
	});

	test("a narrower terminal rebuilds the pixels", () => {
		expect(needsImageRebuild({ maxColumns: 44, maxRows: 22 }, { maxColumns: 30, maxRows: 22 })).toBe(true);
	});

	test("a wider terminal rebuilds them back to full size", () => {
		// The regression this guards: shrinking used to gate the rebuild forever,
		// so the splash stayed small after the window was restored.
		expect(needsImageRebuild({ maxColumns: 30, maxRows: 22 }, { maxColumns: 44, maxRows: 22 })).toBe(true);
	});
});
