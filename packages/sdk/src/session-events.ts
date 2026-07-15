// Pure, browser-safe subpath barrel for the shared session-event mapping pipeline.
// Re-exports only type-only-importing modules so the webui (Mode B console-direct)
// can compose the same raw→ProviderSessionEvent→contract-SessionEvent pipeline that
// the server (Mode A) uses, WITHOUT pulling in the Node-only main SDK bundle.

export { sanitizeSessionEvent, sanitizeSessionEvents } from "./internal/core/session-event-sanitizer.ts";
export { toSessionEvent as toBailianSessionEvent } from "./internal/providers/bailian/event-mapper.ts";
