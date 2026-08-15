import type { SessionEvent } from "@openagentpack/sdk";

export function sessionEventKey(event: SessionEvent): string {
	if (event.event_id) return `id:${event.event_id}`;
	return `fallback:${event.type}:${event.role ?? ""}:${event.created_at ?? ""}:${JSON.stringify(event.content ?? [])}`;
}

export function mergeSessionEvents(current: SessionEvent[], incoming: SessionEvent[]): SessionEvent[] {
	const merged = [...current];
	const seen = new Set(current.map(sessionEventKey));
	for (const event of incoming) {
		const key = sessionEventKey(event);
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(event);
	}
	return merged;
}
