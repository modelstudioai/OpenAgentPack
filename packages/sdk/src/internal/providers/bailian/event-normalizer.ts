import { type SessionEventSanitizerOptions, sanitizeSessionEvent } from "../../core/session-event-sanitizer.ts";
import type { SessionEvent } from "../../types/dto.ts";
import type { ProviderSessionEvent } from "../../types/session-event.ts";
import { BailianEventAccumulator } from "./event-accumulator.ts";

export interface BailianSessionEventNormalizerOptions extends SessionEventSanitizerOptions {
	/** Maximum retained identities, orphan frames and blocks per message. Defaults to 1024. */
	maxEntries?: number;
}

export interface BailianSessionEventNormalizer {
	/** Consume one parsed Bailian business frame, returning a cumulative contract snapshot. */
	push(raw: Record<string, unknown>): SessionEvent | undefined;
	/** Display and protect history; unfinished text is never used as a resumed delta baseline. */
	seed(raw: Record<string, unknown>): SessionEvent | undefined;
	/** Release all state. Call before rebuilding history or changing the logical session. */
	clear(): void;
}

/**
 * Pure browser-safe Bailian conversion. No HTTP, credentials, SSE framing or retry policy.
 * Use one instance per subscription. Redaction/truncation default to true; raw defaults off.
 */
export function createBailianSessionEventNormalizer(
	options: BailianSessionEventNormalizerOptions = {},
): BailianSessionEventNormalizer {
	const { maxEntries, ...policy } = options;
	const accumulator = new BailianEventAccumulator({ maxEntries, boundContentBlocks: true });
	const normalize = (event: ProviderSessionEvent | undefined): SessionEvent | undefined =>
		event === undefined ? undefined : sanitizeSessionEvent(event, policy);
	return {
		push: (raw) => normalize(accumulator.push(raw)),
		seed: (raw) => normalize(accumulator.seedSnapshot(raw)),
		clear: () => accumulator.clear(),
	};
}
