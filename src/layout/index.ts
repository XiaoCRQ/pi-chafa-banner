/**
 * Public surface of the layout layer.
 *
 *   - `layout/tree.ts`    — the recursive node tree, defaults, chafa planning
 *   - `layout/measure.ts` — weighted allocation, measuring, recursive boxes
 *   - `layout/render-tree.ts` — the recursive renderer (tree + boxes -> rows)
 *   - `layout/box.ts`     — borders, wrapping, resource sections
 *   - `layout/palette.ts` — theme roles → ANSI (preset + per-role overrides)
 *   - `layout/compose.ts` — two columns, centering, clamping, compact splash
 *   - `layout/metrics.ts` — document body and block width budgets
 */

export * from "./tree.ts";
export * from "./measure.ts";
export * from "./render-tree.ts";
export * from "./box.ts";
export * from "./palette.ts";
export * from "./compose.ts";
export * from "./metrics.ts";
