/**
 * The text half of the splash: the coding-agent card, the RESOURCES groups and
 * the "no picture yet" card.
 *
 * Pure functions of `(config, resources, …)` so the component stays a lifecycle
 * shell and these are trivially testable.
 */

import { formatSize, type BannerConfig, type PanelField, type ResourceSectionId } from "../config.ts";
import type { FrameSet } from "../frames.ts";
import { panel, type InfoRow, type Painter, type ResourceSection } from "../layout.ts";
import { truncateToWidth } from "../text.ts";

import type { BannerResources } from "../resources.ts";

/**
 * The thinking level rides along as the model row's suffix instead of getting a
 * `[Thinking]` line of its own: it is one short word, and a suffix keeps its
 * budget when the model name is long enough to truncate.
 */
function thinkingSuffix(resources: BannerResources): string | undefined {
	return resources.thinking === "unknown" ? undefined : `· ${resources.thinking}`;
}

/** Facts shown in the coding-agent box, in `panels.info.fields` order. */
export function infoRows(
	config: BannerConfig,
	resources: BannerResources,
	frames: FrameSet | undefined,
): InfoRow[] {
	const values: Record<PanelField, string> = {
		version: resources.version,
		model: resources.model,
		gif: config.gifPath ?? "(bundled)",
		frames: frames ? `${frames.frames.length}/${frames.totalFrames}` : "pending",
	};
	// Labels are capitalised because each one is rendered as a `[Label]`
	// heading, matching the `[Context]` / `[Skills]` style of RESOURCES.
	return config.panels.info.fields.map((field) => {
		const row: InfoRow = {
			label: field.charAt(0).toUpperCase() + field.slice(1),
			value: values[field] ?? "",
		};
		if (field === "model") {
			const suffix = thinkingSuffix(resources);
			if (suffix) row.suffix = suffix;
		}
		return row;
	});
}

/** Resource groups the RESOURCES box lists, in `panels.resources.sections` order. */
export function sections(config: BannerConfig, resources: BannerResources): ResourceSection[] {
	const all: Record<ResourceSectionId, ResourceSection> = {
		context: { title: "Context", names: resources.context },
		skills: { title: "Skills", names: resources.skills },
		// Extensions get one row each: `pkg:entry` labels are too similar to
		// comma-wrap without becoming a wall of text.
		extensions: { title: "Extensions", names: resources.extensions, stacked: true },
	};
	return config.panels.resources.sections.map((id) => all[id]).filter(Boolean);
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

/** One dimmed status line, clipped to the block. */
export function statusLines(status: string | undefined, blockWidth: number, painter: Painter): string[] {
	if (!status) return [];
	return [painter.fg("dim", truncateToWidth(status, blockWidth, "…"))];
}

/**
 * Character-mode "building" card that reserves the art's footprint. The box sits
 * at the top so the panels below it keep their row when the frames arrive.
 */
export function charPlaceholder(painter: Painter, status: string | undefined, width: number, height: number): string[] {
	const note = status
		? `unavailable: ${truncateToWidth(status, Math.max(8, width - 12), "…")}`
		: "rendering chafa frames…";
	const box = panel("IMAGE", [painter.fg("dim", note)], width, painter);
	if (box.length >= height) return box.slice(0, height);
	return [...box, ...Array.from({ length: height - box.length }, () => "")];
}

/** Short, stable description used by `/splash status` and the preview script. */
export function describeConfig(config: BannerConfig): string {
	const chafa = config.chafaArgs.length > 0 ? ` chafa="${config.chafaArgs.join(" ")}"` : "";
	return `size=${formatSize(config.size)} fps=${config.fps === "auto" ? "native" : config.fps} stride=${config.stride} theme=${config.theme.preset} mode=${config.static ? "static" : "anim"}${chafa}`;
}
