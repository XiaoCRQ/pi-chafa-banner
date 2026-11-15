import { describe, expect, test } from "bun:test";
import {
	DEFAULT_FRAME_DELAY_MS,
	aggregateDelays,
	decimatedIndices,
	describeTiming,
	probeGifTiming,
	sampledIndices,
	thinDelays,
} from "../src/pipeline/timing.ts";

describe("timing: sampling", () => {
	test("sampledIndices keeps every stride-th frame", () => {
		expect(sampledIndices(24, 3)).toEqual([0, 3, 6, 9, 12, 15, 18, 21]);
		expect(sampledIndices(5, 1)).toEqual([0, 1, 2, 3, 4]);
		expect(sampledIndices(1, 3)).toEqual([0]);
		expect(sampledIndices(0, 3)).toEqual([0]);
	});

	test("decimatedIndices spreads the kept frames evenly", () => {
		expect(decimatedIndices(8, 4)).toEqual([0, 2, 4, 6]);
		expect(decimatedIndices(24, 24)).toHaveLength(24);
		expect(decimatedIndices(3, 1)).toEqual([0]);
		expect(decimatedIndices(0, 4)).toEqual([]);
	});
});

describe("timing: aggregation", () => {
	test("a sampled frame inherits the delays of the frames it replaced", () => {
		const delays = Array.from({ length: 24 }, () => 100);
		const kept = sampledIndices(24, 3);
		expect(aggregateDelays(delays, kept)).toEqual(Array.from({ length: 8 }, () => 300));
	});

	test("the loop keeps its real length at any stride", () => {
		const delays = [80, 80, 80, 250, 80, 80];
		const total = delays.reduce((sum, value) => sum + value, 0);
		for (const stride of [1, 2, 3]) {
			const gaps = aggregateDelays(delays, sampledIndices(delays.length, stride));
			expect(gaps.reduce((sum, value) => sum + value, 0)).toBe(total);
		}
	});

	test("thinDelays follows decimate() and preserves the total", () => {
		const delays = Array.from({ length: 8 }, () => 300);
		// decimate() picks indices 0, 2, 4, 7 for 8 -> 4, so the last bucket is a
		// single frame and the third one swallows three.
		expect(thinDelays(delays, 4)).toEqual([600, 600, 900, 300]);
		expect(thinDelays(delays, 4).reduce((sum, value) => sum + value, 0)).toBe(2400);
		expect(thinDelays(delays, 1)).toEqual([2400]);
		expect(thinDelays([120, 80], 4)).toEqual([120, 80]);
		expect(thinDelays(delays, 0)).toEqual([]);
	});

	test("an empty delay list falls back to the gif default", () => {
		expect(aggregateDelays([], [0, 1])).toEqual([DEFAULT_FRAME_DELAY_MS, DEFAULT_FRAME_DELAY_MS]);
	});
});

describe("timing: describeTiming", () => {
	test("reports frames, loop length and average rate", () => {
		expect(describeTiming([300, 300, 300, 300, 300, 300, 300, 300])).toBe("8f/2.40s 3.3fps");
		expect(describeTiming([])).toBe("0 frames");
	});
});

describe("timing: probeGifTiming", () => {
	test("reads per-frame delays from a real gif", async () => {
		const timing = await probeGifTiming(`${import.meta.dir}/../assets/banner.gif`);
		const total = timing.delays.reduce((sum, value) => sum + value, 0);
		expect(timing.delays.length).toBeGreaterThan(1);
		expect(timing.delays.every((value) => value > 0)).toBe(true);
		expect(Math.abs(total - timing.totalMs)).toBeLessThanOrEqual(timing.delays.length);
		expect(timing.totalMs).toBeGreaterThan(200);
	});

	test("a missing file degrades to the default delay instead of throwing", async () => {
		const timing = await probeGifTiming("/nonexistent/does-not-exist.gif");
		expect(timing.delays).toEqual([DEFAULT_FRAME_DELAY_MS]);
		expect(timing.totalMs).toBe(DEFAULT_FRAME_DELAY_MS);
	});
});
