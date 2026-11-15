/**
 * Detach pi's built-in loaded-resource listing so only our splash shows.
 *
 * pi composes the transcript document as:
 *
 *     documentContainer
 *       ├─ headerContainer            <- ctx.ui.setHeader() replaces only this child
 *       ├─ loadedResourcesContainer   <- "[Context] [Skills] [Themes] [Extensions]" listing
 *       ├─ chatContainer
 *       └─ pendingMessagesContainer
 *
 * (`interactive-mode.js`: `documentContainer.addChild(headerContainer)`,
 * `documentContainer.addChild(loadedResourcesContainer)`, …). `setHeader()`
 * touches nothing but the header child, and `showLoadedResources()` fills the
 * listing whenever `shouldShowStartupDetails()` is true — i.e. whenever
 * `quietStartup !== false`, which is pi's default. Result: the splash renders,
 * and pi prints its own resource summary right below it.
 *
 * There is no public API to hide that listing (`quietStartup` is a user
 * setting and this extension must never write `settings.json`). The listing
 * container *is* reachable though: pi hands the `tui` root to the header
 * factory, containers expose `children` / `removeChild`, and the listing is
 * always the sibling immediately after the header container. Detaching it is
 * therefore a runtime-only operation: pi keeps filling the (now unmounted)
 * container, nothing is rendered, no files change, and a restart restores the
 * stock behaviour.
 *
 * pi's component tree is not part of the published contract, so everything
 * here is defensive and duck-typed: an unexpected shape simply returns false
 * and the caller degrades to "listing stays visible".
 */

/** The subset of pi-tui's `Container` we rely on. */
export interface ContainerLike {
	children: unknown[];
	removeChild(child: unknown): void;
}

/** Containers are a handful of levels deep; the cap keeps cycles cheap. */
export const MAX_TREE_DEPTH = 8;

/** Duck-type a pi-tui container: an array of children plus a removeChild(). */
export function asContainer(value: unknown): ContainerLike | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	try {
		const candidate = value as { children?: unknown; removeChild?: unknown };
		if (!Array.isArray(candidate.children)) return undefined;
		if (typeof candidate.removeChild !== "function") return undefined;
		return candidate as unknown as ContainerLike;
	} catch {
		// Hostile/lazy getters: treat as "not a container".
		return undefined;
	}
}

/** Breadth-first search for the container that directly holds `target`. */
export function findParentOf(
	host: unknown,
	target: unknown,
	maxDepth: number = MAX_TREE_DEPTH,
): ContainerLike | undefined {
	const root = asContainer(host);
	if (!root || target === undefined || target === null) return undefined;

	const seen = new Set<unknown>();
	const queue: Array<{ node: ContainerLike; depth: number }> = [{ node: root, depth: 0 }];
	while (queue.length > 0) {
		const { node, depth } = queue.shift() as { node: ContainerLike; depth: number };
		if (seen.has(node)) continue;
		seen.add(node);
		if (node.children.includes(target)) return node;
		if (depth >= maxDepth) continue;
		for (const child of node.children) {
			const container = asContainer(child);
			if (container) queue.push({ node: container, depth: depth + 1 });
		}
	}
	return undefined;
}

/** A listing container removed from pi's tree, with a way to put it back. */
export interface DetachedListing {
	/** The container that was removed; pi keeps filling it (render output is dropped). */
	readonly container: unknown;
	/** Re-insert it at its original index (`/splash off`). */
	restore(): boolean;
}

function invalidate(node: ContainerLike): void {
	const maybe = node as { invalidate?: unknown };
	if (typeof maybe.invalidate !== "function") return;
	try {
		(maybe.invalidate as () => void)();
	} catch {
		// invalidate() is best effort; the next requestRender() repaints anyway.
	}
}

/**
 * Remove pi's `loadedResourcesContainer` from the live component tree.
 *
 * `header` is the component pi registered for us. pi keeps it inside its own
 * `headerContainer` (next to spacers and the model-scope notice), and the
 * resource listing is the sibling of that *container*:
 *
 *     documentContainer.children = [headerContainer, loadedResourcesContainer, chatContainer, …]
 *
 * So the anchor is `headerContainer` and the target is the child right after
 * it. Two candidate anchors are tried, outer first, because the exact nesting
 * is pi's private business (a flat tree, where the component itself sits next
 * to the listing, still works).
 *
 * A candidate only counts when the child after the anchor is a real container:
 * pi's inner slots are spacers / text, which are plain components.
 */
export function detachResourceListing(
	host: unknown,
	header: unknown,
	maxDepth: number = MAX_TREE_DEPTH,
): DetachedListing | undefined {
	const headerParent = findParentOf(host, header, maxDepth);
	if (!headerParent) return undefined;
	const outer = findParentOf(host, headerParent, maxDepth);

	const candidates: Array<{ container: ContainerLike; anchor: unknown }> = [];
	if (outer) candidates.push({ container: outer, anchor: headerParent });
	candidates.push({ container: headerParent, anchor: header });

	for (const candidate of candidates) {
		const { container, anchor } = candidate;
		const index = container.children.indexOf(anchor);
		if (index < 0) continue;
		const sibling = container.children[index + 1];
		const listing = asContainer(sibling);
		if (!listing || listing === anchor) continue;
		try {
			container.removeChild(sibling);
		} catch {
			continue;
		}
		if (container.children.includes(sibling)) continue;
		return {
			container: sibling,
			restore(): boolean {
				if (container.children.includes(sibling)) return false;
				const at = Math.min(index + 1, container.children.length);
				container.children.splice(at, 0, sibling);
				invalidate(container);
				return container.children.includes(sibling);
			},
		};
	}
	return undefined;
}
