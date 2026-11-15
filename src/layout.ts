/**
 * Layout layer barrel.
 *
 * Pure functions only: no I/O, no pi imports, no timers. Every exported helper
 * guarantees that no returned line is wider than the width it was given.
 */

export * from "./layout/index.ts";
