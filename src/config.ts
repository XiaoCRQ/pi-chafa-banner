/**
 * Barrel kept so call sites can keep importing `./config.ts`.
 *
 * The real implementation lives in `src/config/`: `schema.ts` (shapes, defaults,
 * limits), `validate.ts` (defensive JSON parsing) and `load.ts` (locating and
 * reading the file).
 */
export * from "./config/index.ts";
