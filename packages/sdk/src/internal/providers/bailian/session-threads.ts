import type { EventListOptions, ProviderSessionEventList } from "../../types/session-event.ts";
import type { SessionThreadListOptions, SessionThreadPage } from "../../types/session-thread.ts";
import { assertEventOptions } from "../session-event-options.ts";
import { listEventsAtPathPaged } from "../session-event-response.ts";
import type { BailianClient } from "./client.ts";
import { toSessionEvent } from "./event-mapper.ts";
import { correlateBailianHistoryEvents } from "./history-event-correlation.ts";

export async function listBailianSessionThreads(
	client: BailianClient,
	sessionId: string,
	options: SessionThreadListOptions = {},
): Promise<SessionThreadPage> {
	const query = new URLSearchParams();
	if (options.limit !== undefined) query.set("limit", String(options.limit));
	if (options.page !== undefined) query.set("page", options.page);
	const path = `/sessions/${encodeURIComponent(sessionId)}/threads${query.size ? `?${query}` : ""}`;
	const result = (await client.get(path, { signal: options.signal })) as {
		data?: SessionThreadPage["data"];
		has_more?: boolean;
		next_page?: string | null;
	};
	const nextPage = result.next_page ?? undefined;
	return { data: result.data ?? [], has_more: result.has_more ?? nextPage != null, next_page: nextPage };
}

export async function listBailianSessionThreadEvents(
	client: BailianClient,
	sessionId: string,
	threadId: string,
	options?: EventListOptions,
): Promise<ProviderSessionEventList> {
	assertEventOptions("bailian", options);
	const result = await listEventsAtPathPaged(
		client,
		`/sessions/${encodeURIComponent(sessionId)}/threads/${encodeURIComponent(threadId)}/events`,
		options,
		(raw) => toSessionEvent(raw, options),
		{ forwardTypes: false },
	);
	return options?.event_format === "snapshot"
		? { ...result, events: correlateBailianHistoryEvents(result.events) }
		: result;
}
