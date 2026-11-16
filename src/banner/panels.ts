/**
 * Values the splash windows render, assembled from the session resources.
 *
 * The tree renderer (`layout/render-tree.ts`) owns the drawing; this module only
 * turns `(config, resources, frameCount)` into the `ContentContext` the content
 * providers read, plus the `/splash status` one-liner.
 */

import type { FrameSet } from "../frames.ts";
import type { BannerResources } from "../resources.ts";
import type { ContentContext } from "../content.ts";
import { describeConfig, type BannerConfig } from "../config.ts";

/**
 * Live snapshot the content providers read. `frameCount` is the primary
 * canvas's "frames/total" label (the `frames` provider needs it, if a config
 * asks for it).
 */
export function contentContext(
	config: BannerConfig,
	resources: BannerResources,
	frameCount?: string,
): ContentContext {
	return {
		gifPath: config.gifPath,
		version: resources.version,
		model: resources.model,
		thinking: resources.thinking,
		context: resources.context,
		skills: resources.skills,
		extensions: resources.extensions,
		...(frameCount ? { frameCount } : {}),
	};
}

/** `/splash status` summary: the effective config plus what was built. */
export function buildStatusLine(
	config: BannerConfig,
	frames: FrameSet | undefined,
	frozen: boolean,
): string {
	const framePart = frames
		? `frames=${frames.frames.length}/${frames.totalFrames} (stride ${frames.stride}${frames.fromCache ? ", cached" : ""})`
		: "frames=pending";
	return `${describeConfig(config)}  ${framePart}${frozen ? "  frozen" : ""}`;
}
