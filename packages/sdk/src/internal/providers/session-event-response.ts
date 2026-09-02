import type { EventListOptions, ProviderSessionEvent, ProviderSessionEventList } from "../types/session-event.ts";

/**
 * Shared `listSessionEvents` implementation for the managed-agents-style events
 * endpoint. All providers paginate with the same opaque forward cursor
 * (`page` in, `next_page` out) and shape the same `{events, has_more, next_page}`
 * response. Providers differ in whether the Agents-style `after_id` resume marker and
 * server-side `types` filtering are supported. `has_more` reads the server field when
 * present and otherwise derives from `next_page` — equivalent for endpoints that omit
 * `has_more`.
 */
export async function listSessionEventsPaged(
	client: { get(path: string): Promise<unknown> },
	sessionId: string,
	options: EventListOptions | undefined,
	toEvent: (raw: Record<string, unknown>) => ProviderSessionEvent,
	config?: { forwardAfterId?: boolean; forwardTypes?: boolean },
): Promise<ProviderSessionEventList> {
	const params = new URLSearchParams();
	if (options?.limit) params.set("limit", String(options.limit));
	if (options?.order) params.set("order", options.order);
	if (config?.forwardTypes !== false) {
		for (const type of options?.types ?? []) params.append("types", type);
	}
	if (options?.created_at_gt) params.set("created_at[gt]", options.created_at_gt);
	if (options?.created_at_gte) params.set("created_at[gte]", options.created_at_gte);
	if (options?.created_at_lt) params.set("created_at[lt]", options.created_at_lt);
	if (options?.created_at_lte) params.set("created_at[lte]", options.created_at_lte);
	const pageCursor = options?.page_token ?? options?.page;
	if (pageCursor) params.set("page", pageCursor);
	if (config?.forwardAfterId && options?.after_id) params.set("after_id", options.after_id);
	const qs = params.toString();
	const res = (await client.get(`/sessions/${sessionId}/events${qs ? `?${qs}` : ""}`)) as Record<string, unknown>;
	const data = (res.data ?? []) as Record<string, unknown>[];
	const nextPage = (res.next_page as string | null | undefined) ?? undefined;
	return {
		events: data.map(toEvent),
		has_more: (res.has_more as boolean | undefined) ?? nextPage != null,
		next_page: nextPage,
	};
}

export function extractCreatedEventId(res: Record<string, unknown>): string | undefined {
	if (typeof res.id === "string") return res.id;
	if (typeof res.event_id === "string") return res.event_id;

	for (const key of ["data", "events"]) {
		const items = res[key];
		if (!Array.isArray(items)) continue;
		const first = items[0];
		if (first && typeof first === "object") {
			const id = (first as Record<string, unknown>).id;
			if (typeof id === "string") return id;
		}
	}

	return undefined;
}
