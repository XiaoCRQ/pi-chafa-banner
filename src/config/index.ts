/** Public config surface: schema, validation and file loading. */
export * from "./schema.ts";
export * from "./load.ts";
export * from "./validate.ts";
export * from "./tree.ts";
/** Layout-tree types, so `config.ts` alone is enough for call sites. */
export type { ChafaPlan, ContentSpec, LayoutNode, SplashSettings } from "../layout/tree.ts";
export * from "./legacy.ts";
