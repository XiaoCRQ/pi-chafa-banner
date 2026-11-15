/**
 * Text layer barrel.
 *
 * Split into focused modules for testability:
 *   - `text/ansi.ts`     — escape recognition, `isImageLine`, `stripAnsi`
 *   - `text/width.ts`    — grapheme widths, `visibleWidth`, padding helpers
 *   - `text/truncate.ts` — ANSI-aware truncation and slicing
 */

export * from "./text/index.ts";
