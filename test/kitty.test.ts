import { describe, expect, test } from "bun:test";
import {
	buildKittyLine,
	calculateImageCells,
	encodeKittyAnimFrame,
	encodeKittyChunked,
	encodeKittyRootGap,
	encodeKittyStub,
	encodeKittyDelete,
	reassignKittyImageId,
} from "../src/kitty.ts";
import { parseKittyRows } from "../src/layout.ts";

const ST = "\x1b\\";
const payload = (n: number) => "A".repeat(n);

/** Every `\x1b_G … ;payload ST` command in a line. */
function commands(line: string): string[] {
	const out: string[] = [];
	let index = line.indexOf("\x1b_G");
	while (index !== -1) {
		const end = line.indexOf(ST, index);
		if (end === -1) break;
		out.push(line.slice(index, end + ST.length));
		index = line.indexOf("\x1b_G", end + ST.length);
	}
	return out;
}

function paramsOf(command: string): string {
	const start = "\x1b_G".length;
	const semi = command.indexOf(";", start);
	const end = semi === -1 ? command.length - ST.length : semi;
	return command.slice(start, end);
}

function payloadOf(command: string): string {
	return command.slice(command.indexOf(";") + 1, command.length - ST.length);
}

describe("kitty: chunking", () => {
	test("single chunk carries no m= parameter", () => {
		const out = encodeKittyChunked(payload(16), "a=T,f=100", "");
		expect(out).toBe(`\x1b_Ga=T,f=100;${payload(16)}${ST}`);
		expect(out).not.toContain(",m=");
	});

	test("multi chunk: head params, then a=f on every continuation", () => {
		const data = payload(4096 * 2 + 8);
		const out = encodeKittyChunked(data, "a=f,f=100,i=7,z=63,q=2", "a=f");
		const chunks = commands(out);
		expect(chunks.length).toBe(3);
		for (const chunk of chunks) {
			expect(payloadOf(chunk).length).toBeLessThanOrEqual(4096);
			expect(chunk.endsWith(ST)).toBe(true);
		}
		for (const chunk of chunks.slice(0, -1)) {
			expect(payloadOf(chunk).length % 4).toBe(0);
		}
		expect(paramsOf(chunks[0] ?? "")).toContain("m=1");
		expect(paramsOf(chunks[1] ?? "")).toBe("a=f,m=1");
		expect(paramsOf(chunks[2] ?? "")).toBe("a=f,m=0");
		expect(paramsOf(chunks[0] ?? "")).toContain("i=7");
	});

	test("chunks rejoin into the original payload", () => {
		const data = payload(4096 * 3);
		const rejoined = commands(encodeKittyChunked(data, "a=T", ""))
			.map(payloadOf)
			.join("");
		expect(rejoined).toBe(data);
	});

	test("last chunk of an exactly-aligned payload is the terminator", () => {
		const chunks = commands(encodeKittyChunked(payload(4096 * 2), "a=T", ""));
		expect(chunks.length).toBe(2);
		expect(paramsOf(chunks[1] ?? "")).toBe("m=0");
	});
});

const frames = [
	{ base64: `root${"0".repeat(32)}` },
	{ base64: `f1${"1".repeat(32)}` },
	{ base64: `f2${"2".repeat(32)}` },
];

const images = {
	protocol: "kitty" as const,
	frames,
	columns: 44,
	rows: 22,
	pixelWidth: 396,
	pixelHeight: 396,
	imageId: 42,
	sequence: encodeKittyStub(`root${"0".repeat(32)}`, { columns: 44, rows: 22, imageId: 42 }).sequence,
	gapMs: 63,
	gifPath: "/tmp/x.gif",
	totalFrames: 57,
	stride: 3,
	palette: 128,
	fromCache: false,
	builtAt: 0,
};

describe("kitty: root frame", () => {
	test("stub encoder matches pi-tui's parameter order", () => {
		const { sequence, columns, rows } = encodeKittyStub("AAAA", { columns: 12, rows: 6, imageId: 9 });
		expect(columns).toBe(12);
		expect(rows).toBe(6);
		expect(sequence).toBe(`\x1b_Ga=T,f=100,q=2,C=1,c=12,r=6,i=9;AAAA${ST}`);
		expect(parseKittyRows(sequence)).toBe(6);
	});

	test("static mode emits the root frame only", () => {
		expect(buildKittyLine({ images, animate: false, loopForever: true })).toBe(images.sequence);
	});

	test("a single frame never animates", () => {
		const single = { ...images, frames: [frames[0]!] };
		expect(buildKittyLine({ images: single, animate: true, loopForever: true })).toBe(images.sequence);
	});
});

describe("kitty: animation line", () => {
	const line = buildKittyLine({ images, animate: true, loopForever: true });

	test("orders root frame, root gap, frames, then start", () => {
		const cmds = commands(line);
		expect(cmds.length).toBe(1 + 1 + (frames.length - 1) + 1);
		expect(paramsOf(cmds[0] ?? "")).toContain("a=T");
		expect(paramsOf(cmds[1] ?? "")).toBe("a=a,i=42,r=1,z=63,q=2");
		expect(paramsOf(cmds[2] ?? "")).toContain("a=f");
		expect(paramsOf(cmds[cmds.length - 1] ?? "")).toBe("a=a,i=42,s=3,v=1,q=2");
	});

	test("reserved rows still come from the root frame", () => {
		expect(parseKittyRows(line)).toBe(22);
	});

	test("frame payloads never repeat c= or r=", () => {
		for (const cmd of commands(line).slice(2, -1)) {
			const params = paramsOf(cmd);
			expect(params).not.toContain("c=");
			expect(params).not.toContain("r=");
		}
	});

	test("non-looping start omits v=1", () => {
		const once = buildKittyLine({ images, animate: true, loopForever: false });
		expect(once.endsWith(`\x1b_Ga=a,i=42,s=3,q=2${ST}`)).toBe(true);
	});

	test("frame payloads are transmitted verbatim", () => {
		const cmd = commands(line)[2] ?? "";
		expect(payloadOf(cmd)).toBe(frames[1]!.base64);
	});

	test("every animation frame declares its own format (f=100)", () => {
		// kitty does NOT inherit the root image format for `a=f`: `graphics.c`
		// does `uint32_t fmt = g->format ? g->format : RGBA;`, so a frame without
		// `f=100` is parsed as raw 32-bit RGBA, fails the size check and silently
		// takes every continuation chunk down with it (q=2 swallows the error).
		// Net effect on a real terminal: the animation stays on the root frame.
		for (const cmd of commands(line).slice(2, -1)) {
			expect(paramsOf(cmd)).toContain("f=100");
		}
	});

	test("every command header is quiet (q=2), continuation chunks carry a=f only", () => {
		const cmds = commands(line);
		// kitty writes `OK`/`ENOENT` back to the tty without q=2, and pi's stdin
		// parser would happily read that as key presses.
		expect(paramsOf(cmds[0] ?? "")).toContain("q=2");
		expect(paramsOf(cmds[1] ?? "")).toContain("q=2");
		expect(paramsOf(cmds[2] ?? "")).toContain("q=2");
		expect(paramsOf(cmds[cmds.length - 1] ?? "")).toContain("q=2");
		// Continuations are plain `a=f,m=…` — no params are inherited, so they
		// cannot carry q=2 themselves; the head chunk of each command does.
		const continuation = commands(
			encodeKittyChunked("B".repeat(4096 * 2 + 8), "a=f,f=100,i=42,z=63,q=2", "a=f"),
		)[1];
		expect(paramsOf(continuation ?? "")).toBe("a=f,m=1");
	});
});

describe("kitty: individual commands", () => {
	test("root gap is quiet and honors the frame gap", () => {
		expect(encodeKittyRootGap(42, 63)).toBe(`\x1b_Ga=a,i=42,r=1,z=63,q=2${ST}`);
		expect(encodeKittyRootGap(42, 0.2)).toContain("z=1");
	});

	test("animation frame head carries a=f, f=100, z and q=2", () => {
		const cmds = commands(encodeKittyAnimFrame("A".repeat(16), 42, 63));
		expect(cmds.length).toBe(1);
		expect(paramsOf(cmds[0] ?? "")).toBe("a=f,f=100,i=42,z=63,q=2");
	});

	test("animation frame continuations stay a=f,m=…", () => {
		const chunks = commands(encodeKittyAnimFrame("A".repeat(4096 + 16), 42, 63));
		expect(chunks.length).toBe(2);
		expect(paramsOf(chunks[1] ?? "")).toBe("a=f,m=0");
	});
});

describe("kitty: cell grid", () => {
	test("a grid that already matches the budget is preserved", () => {
		expect(calculateImageCells({ widthPx: 396, heightPx: 396 }, { widthPx: 9, heightPx: 18 }, 44, 22)).toEqual({
			columns: 44,
			rows: 22,
		});
	});

	test("oversized images shrink to the budget", () => {
		const cell = calculateImageCells({ widthPx: 2000, heightPx: 2000 }, { widthPx: 9, heightPx: 18 }, 44, 22);
		expect(cell.columns).toBeLessThanOrEqual(44);
		expect(cell.rows).toBeLessThanOrEqual(22);
	});
});

describe("kitty: teardown and re-targeting", () => {
	test("delete targets one image id and stays quiet", () => {
		expect(encodeKittyDelete(4242)).toBe("\x1b_Ga=d,d=I,i=4242,q=2\x1b\\");
		// Never `d=A`/`d=a`: that would wipe images owned by other extensions.
		expect(encodeKittyDelete(7)).not.toContain("d=A");
	});

	test("reassigning the id touches only the first chunk head", () => {
		const line = buildKittyLine({
			images: { sequence: `\x1b_Ga=T,f=100,q=2,C=1,c=4,r=2,i=99;${payload(9000)}\x1b\\`, frames: [{ base64: payload(4) }], gapMs: 50 },
			animate: true,
			loopForever: true,
		} as unknown as Parameters<typeof buildKittyLine>[0]);
		const retargeted = reassignKittyImageId(line, 1234);
		const chunks = commands(retargeted);
		expect(paramsOf(chunks[0] ?? "")).toContain("i=1234");
		expect(paramsOf(chunks[0] ?? "")).not.toContain("i=99");
		// Every following chunk still belongs to the root transmission.
		for (const chunk of chunks.slice(1)) expect(paramsOf(chunk)).toBe("m=0");
		expect(retargeted).not.toContain("i=99");
		expect(payloadOf(chunks[0] ?? "")).toBe(payloadOf(commands(line)[0] ?? ""));
	});

	test("an id-less head gets one appended", () => {
		expect(reassignKittyImageId("\x1b_Ga=T,f=100;AAAA\x1b\\", 5)).toBe("\x1b_Ga=T,f=100,i=5;AAAA\x1b\\");
	});
});
