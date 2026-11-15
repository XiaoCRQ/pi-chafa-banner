/**
 * Public surface of the layout layer.
 *
 *   - `layout/box.ts`     — borders, wrapping, resource sections
 *   - `layout/palette.ts` — theme roles → ANSI (preset + per-role overrides)
 *   - `layout/compose.ts` — two columns, centering, clamping, compact splash
 *   - `layout/metrics.ts` — document body and block width budgets
 */

export * from "./box.ts";
export * from "./palette.ts";
export * from "./compose.ts";
export * from "./metrics.ts";
