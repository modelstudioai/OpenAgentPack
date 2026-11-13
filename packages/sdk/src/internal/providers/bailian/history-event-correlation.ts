import type { ProviderSessionEvent } from "../../types/session-event.ts";
import { deriveArtifacts } from "./snapshot-mapper.ts";

/**
 * Correlate within one fetched page only. The provider may return descending order,
 * so collect identities before decorating outputs; never guess across queries/pages.
 */
export function correlateBailianHistoryEvents(events: ProviderSessionEvent[]): ProviderSessionEvent[] {
	const names = new Map<string, string | null>();
	for (const event of events) {
		const callId = event.snapshot?.metadata?.call_id;
		if (event.type !== "tool_use" || typeof callId !== "string" || !callId || !event.tool_name) continue;
		const previous = names.get(callId);
		names.set(callId, previous !== undefined && previous !== event.tool_name ? null : event.tool_name);
	}
	return events.map((event) => {
		const snapshot = event.snapshot;
		const callId = snapshot?.metadata?.call_id;
		if (event.type !== "tool_result" || event.tool_name || !snapshot || typeof callId !== "string") return event;
		const name = names.get(callId);
		if (!name) return event;
		const correlated: ProviderSessionEvent = {
			...event,
			tool_name: name,
			snapshot: { ...snapshot, metadata: { ...snapshot.metadata, tool_name: name } },
		};
		deriveArtifacts(correlated);
		return correlated;
	});
}
