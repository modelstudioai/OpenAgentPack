// Pure, browser-safe subpath barrel for the shared session-event mapping pipeline.
// Re-exports only browser-safe pure modules so browser consumers can compose the
// same raw→ProviderSessionEvent→contract-SessionEvent pipeline that the server uses,
// WITHOUT pulling in the Node-only main SDK bundle.

export type { SessionEventSanitizerOptions } from "./internal/core/session-event-sanitizer.ts";
export { sanitizeSessionEvent, sanitizeSessionEvents } from "./internal/core/session-event-sanitizer.ts";
export { toSessionEvent as toBailianSessionEvent } from "./internal/providers/bailian/event-mapper.ts";
export {
	type BailianSessionEventNormalizer,
	type BailianSessionEventNormalizerOptions,
	createBailianSessionEventNormalizer,
} from "./internal/providers/bailian/event-normalizer.ts";
export type { SessionEvent } from "./internal/types/dto.ts";
