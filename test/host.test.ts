import { describe, expect, test } from "bun:test";
import {
	asContainer,
	detachResourceListing,
	findParentOf,
	MAX_TREE_DEPTH,
} from "../src/host.ts";

/** Minimal stand-in for pi-tui's `Container`. */
class FakeContainer {
	children: unknown[] = [];
	invalidated = 0;

	constructor(...children: unknown[]) {
		this.children = children;
	}

	addChild(child: unknown): void {
		this.children.push(child);
	}

	removeChild(child: unknown): void {
		const index = this.children.indexOf(child);
		if (index >= 0) this.children.splice(index, 1);
	}

	invalidate(): void {
		this.invalidated += 1;
	}
}

/**
 * Mirrors pi's document: `documentContainer` = [headerContainer(header),
 * loadedResourcesContainer, chatContainer, …].
 */
function makeTree(options: { listing?: boolean; extra?: unknown[] } = {}) {
	const header = { render: () => [] };
	const listing = new FakeContainer("skills");
	const chat = new FakeContainer("messages");
	const headerContainer = new FakeContainer(header);
	const document = new FakeContainer(headerContainer);
	if (options.listing !== false) document.addChild(listing);
	document.addChild(chat);
	for (const child of options.extra ?? []) document.addChild(child);
	return { root: new FakeContainer(document), header, listing, chat, headerContainer, document };
}

describe("asContainer", () => {
	test("accepts objects with a children array and removeChild()", () => {
		const container = new FakeContainer();
		expect(asContainer(container)).toBe(container);
	});

	test("rejects everything else", () => {
		expect(asContainer(undefined)).toBeUndefined();
		expect(asContainer(null)).toBeUndefined();
		expect(asContainer("container")).toBeUndefined();
		expect(asContainer({ children: [] })).toBeUndefined();
		expect(asContainer({ removeChild: () => {} })).toBeUndefined();
		expect(asContainer([1, 2, 3])).toBeUndefined();
	});
});

describe("findParentOf", () => {
	test("finds the direct parent through the tui → document → header path", () => {
		const { root, header, headerContainer } = makeTree();
		expect(findParentOf(root, header)).toBe(headerContainer);
	});

	test("returns undefined for unknown targets", () => {
		const { root } = makeTree();
		expect(findParentOf(root, { render: () => [] })).toBeUndefined();
		expect(findParentOf(root, undefined)).toBeUndefined();
		expect(findParentOf(undefined, "x")).toBeUndefined();
	});

	test("stops at maxDepth", () => {
		const leaf = { render: () => [] };
		let node: unknown = leaf;
		const chain: FakeContainer[] = [];
		for (let i = 0; i <= MAX_TREE_DEPTH + 1; i += 1) {
			const container = new FakeContainer(node);
			chain.push(container);
			node = container;
		}
		// The deepest container is far beyond the cap.
		expect(findParentOf(node, leaf)).toBeUndefined();
		expect(findParentOf(node, leaf, MAX_TREE_DEPTH + 4)).toBe(chain[0] as FakeContainer);
	});

	test("survives cycles", () => {
		const root = new FakeContainer();
		root.addChild(root);
		const header = { render: () => [] };
		root.addChild(header);
		expect(findParentOf(root, header)).toBe(root);
	});
});

describe("detachResourceListing", () => {
	test("removes the container right after the header container", () => {
		const { root, header, listing, document, chat } = makeTree();
		const detached = detachResourceListing(root, header);
		expect(detached).toBeDefined();
		expect(detached?.container).toBe(listing);
		expect(document.children).not.toContain(listing);
		// Nothing else moved: the listing was the only removal.
		expect(document.children).toEqual([document.children[0], chat]);
	});

	test("restore() puts the listing back at its original position", () => {
		const { root, header, listing, document } = makeTree();
		const detached = detachResourceListing(root, header);
		expect(detached).toBeDefined();
		expect(detached?.restore()).toBe(true);
		expect(document.children[1]).toBe(listing);
		expect(document.invalidated).toBe(1);
		// Restoring twice is a no-op, not a duplicate insert.
		expect(detached?.restore()).toBe(false);
		expect(document.children.filter((child) => child === listing)).toHaveLength(1);
	});

	test("returns undefined when the header is not mounted", () => {
		const { root } = makeTree();
		expect(detachResourceListing(root, { render: () => [] })).toBeUndefined();
	});

	test("returns undefined when nothing follows the header container", () => {
		const header = { render: () => [] };
		const headerContainer = new FakeContainer(header);
		const document = new FakeContainer(headerContainer);
		const root = new FakeContainer(document);
		expect(detachResourceListing(root, header)).toBeUndefined();
		expect(document.children).toEqual([headerContainer]);
	});

	test("walks past pi's inner spacers to the outer listing", () => {
		// Real host shape: headerContainer = [Spacer, customHeader, Spacer].
		const header = { render: () => [] };
		const spacer = { render: () => [] };
		const listing = new FakeContainer("skills");
		const chat = new FakeContainer("messages");
		const headerContainer = new FakeContainer(spacer, header, { render: () => [] });
		const document = new FakeContainer(headerContainer, listing, chat);
		const root = new FakeContainer(document);

		const detached = detachResourceListing(root, header);
		expect(detached?.container).toBe(listing);
		expect(document.children).toEqual([headerContainer, chat]);
	});

	test("falls back to an inner container when the outer has no listing", () => {
		const inner = new FakeContainer("inner");
		const header = { render: () => [] };
		const headerContainer = new FakeContainer(header, inner);
		const document = new FakeContainer(headerContainer);
		const root = new FakeContainer(document);

		const detached = detachResourceListing(root, header);
		expect(detached?.container).toBe(inner);
		expect(headerContainer.children).toEqual([header]);
	});

	test("handles a flat tree where the component sits in the document", () => {
		const header = { render: () => [] };
		const listing = new FakeContainer("skills");
		const document = new FakeContainer(header, listing);
		const root = new FakeContainer(document);
		const detached = detachResourceListing(root, header);
		expect(detached?.container).toBe(listing);
		expect(document.children).toEqual([header]);
	});

	test("refuses to remove a plain object sibling", () => {
		const header = { render: () => [] };
		const document = new FakeContainer(header, "spacer");
		const root = new FakeContainer(document);
		expect(detachResourceListing(root, header)).toBeUndefined();
		expect(document.children).toContain("spacer");
	});

	test("reports failure when removeChild() does not remove", () => {
		const stuck = new FakeContainer();
		stuck.removeChild = () => {};
		const header = { render: () => [] };
		const headerContainer = new FakeContainer(header);
		stuck.addChild(headerContainer);
		stuck.addChild(new FakeContainer());
		const root = new FakeContainer(stuck);
		expect(detachResourceListing(root, header)).toBeUndefined();
	});

	test("never throws on hostile input", () => {
		const hostile = {
			get children(): unknown[] {
				throw new Error("boom");
			},
			removeChild: () => {},
		};
		expect(() => detachResourceListing(hostile, {})).not.toThrow();
		expect(detachResourceListing(hostile, {})).toBeUndefined();
	});
});
