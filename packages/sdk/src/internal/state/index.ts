/**
 * Internal state persistence layer (file + in-memory backends).
 *
 * Not part of the public SDK surface: these symbols live under src/internal and
 * are re-exported selectively from the package entry (src/index.ts).
 */

export type { StateBackend, StateScope } from "./backend.ts";
export { InMemoryStateBackend } from "./in-memory-state-backend.ts";
export { LocalFileStateBackend, type LocalFileStateBackendOptions } from "./local-file-state-backend.ts";
export { type IStateManager, StateManager } from "./state-manager.ts";
