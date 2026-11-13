import { assertEventOptions } from "../providers/session-event-options.ts";
import type { EventListOptions, ProviderSessionEventList } from "../types/session-event.ts";
import type { SessionThreadListOptions, SessionThreadPage } from "../types/session-thread.ts";
import { type ManagedApiContext, requireManagedApiMethod, resolveManagedApiAdapter } from "./managed-api-context.ts";
import { filterSessionEventPage, sessionEventListOptions } from "./session-event-list-options.ts";
import type { SessionRuntimeTarget } from "./session-runtime.ts";

/** List child Agent executions. Bailian's main thrd_* is not returned by this endpoint. */
export async function listSessionThreads(
	ctx: ManagedApiContext,
	sessionId: string,
	options: SessionRuntimeTarget & SessionThreadListOptions = {},
): Promise<SessionThreadPage> {
	const adapter = resolveManagedApiAdapter(ctx, options.provider);
	const method = requireManagedApiMethod(adapter.listSessionThreads, adapter.name, "session thread listing");
	return method.call(adapter, sessionId, { limit: options.limit, page: options.page, signal: options.signal });
}

/** Query a child Agent's history without starting a separate stream or changing the active Session. */
export async function listSessionThreadEvents(
	ctx: ManagedApiContext,
	sessionId: string,
	threadId: string,
	options: SessionRuntimeTarget & EventListOptions = {},
): Promise<ProviderSessionEventList> {
	const adapter = resolveManagedApiAdapter(ctx, options.provider);
	const method = requireManagedApiMethod(adapter.listSessionThreadEvents, adapter.name, "session thread events");
	assertEventOptions(adapter.name, options);
	const result = await method.call(adapter, sessionId, threadId, sessionEventListOptions(options));
	return filterSessionEventPage(result, options.types);
}
