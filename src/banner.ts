/**
 * Banner layer barrel.
 *
 * pi calls `render(width)` synchronously on every frame, so all animation frames
 * are pre-rendered by the pipeline and this layer only composes (and indexes
 * into) them. See `banner/component.ts` for the lifecycle contract.
 */

export * from "./banner/index.ts";
