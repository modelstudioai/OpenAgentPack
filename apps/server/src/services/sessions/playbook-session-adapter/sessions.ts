import type { DeletePlaybookSessionInput, SendPlaybookSessionInput } from "@openagentpack/playbooks";
import {
	deleteSession,
	getAgent,
	getSession,
	listSessionEvents,
	listSessionSummaries,
	type ProjectRuntimeContext,
	type ProviderSessionEvent,
	resolveSessionProvider,
	type Session,
	sendSessionMessageStreaming,
} from "@openagentpack/sdk";
import { DEFAULT_AGENT_ID, getSessionAgent } from "@/services/agents/catalog";
import { withAgentRuntime } from "@/services/runtime-factory";
import { createEventBuffer, seedCompletedBuffer } from "@/services/sessions/event-buffer";
import { sortByUpdatedDesc, toSession } from "./dto";

export type PlaybookSessionDetail = {
	session: Session;
	events: ProviderSessionEvent[];
	eventsNextPageToken?: string;
};

export type SessionEventsPage = {
	events: ProviderSessionEvent[];
	eventsNextPageToken?: string;
};

type ListPlaybookSessionsInput = {
	playbookId?: string;
	remoteAgentId?: string;
	limit?: number;
	pageToken?: string;
};

export async function listPlaybookSessions(
	input: ListPlaybookSessionsInput,
): Promise<{ sessions: Session[]; nextPageToken?: string }> {
	const limit = input.limit ?? 50;
	const page = input.pageToken?.trim() || undefined;
	const runtimePlaybookId = input.playbookId ?? DEFAULT_AGENT_ID;
	return withAgentRuntime(runtimePlaybookId, async (ctx, compiled) => {
		if (input.remoteAgentId) {
			const provider = resolveSessionProvider(compiled.agentId, ctx.config);
			const { summaries, nextPage } = await listSessionSummaries(ctx, {
				provider,
				filter: { agent_id: input.remoteAgentId, limit, page },
			});
			const sessions = summaries
				.map((summary) => toSession(summary.session, input.remoteAgentId ?? compiled.agentId))
				.filter((session) => session.agent?.agent_id === input.remoteAgentId)
				.sort(sortByUpdatedDesc);
			return { sessions, nextPageToken: nextPage ?? undefined };
		}

		let remoteId: string | undefined;
		if (input.playbookId) {
			const provider = resolveSessionProvider(compiled.agentId, ctx.config);
			remoteId = ctx.state.getResource({ type: "agent", name: compiled.agentId, provider })?.remote_id ?? undefined;
			if (!remoteId) return { sessions: [], nextPageToken: undefined };
		}
		const target = input.playbookId
			? { agent: compiled.agentId, filter: { limit, page } }
			: { filter: { limit, page } };
		const { summaries, nextPage } = await listSessionSummaries(ctx, target);
		const sessions = summaries
			.map((summary) => toSession(summary.session, compiled.agentId))
			.filter((session) => !remoteId || session.agent?.agent_id === remoteId)
			.sort(sortByUpdatedDesc);
		return { sessions, nextPageToken: nextPage ?? undefined };
	});
}

async function listProviderSessionEventsPage(
	ctx: ProjectRuntimeContext,
	sessionId: string,
	provider: string,
	options: { pageToken?: string; limit?: number } = {},
): Promise<SessionEventsPage> {
	const limit = options.limit ?? 100;
	const eventList = await listSessionEvents(ctx, sessionId, {
		provider,
		limit,
		order: "desc",
		page_token: options.pageToken,
	});
	return {
		events: [...eventList.events].reverse(),
		eventsNextPageToken: eventList.next_page,
	};
}

export async function listProviderSessionEvents(
	sessionId: string,
	agentId = DEFAULT_AGENT_ID,
	pageToken?: string,
	limit?: number,
): Promise<SessionEventsPage> {
	const catalogAgentId = getSessionAgent(agentId) ? agentId : DEFAULT_AGENT_ID;
	return withAgentRuntime(catalogAgentId, async (ctx, compiled) => {
		const agent = getAgent(ctx, compiled.agentId);
		return listProviderSessionEventsPage(ctx, sessionId, agent.provider, { pageToken, limit });
	});
}

export async function readProviderSessionDetail(
	sessionId: string,
	agentId = DEFAULT_AGENT_ID,
): Promise<PlaybookSessionDetail> {
	const catalogAgentId = getSessionAgent(agentId) ? agentId : DEFAULT_AGENT_ID;
	return withAgentRuntime(catalogAgentId, async (ctx, compiled) => {
		const agent = getAgent(ctx, compiled.agentId);
		const [session, eventPage] = await Promise.all([
			getSession(ctx, sessionId, agent.provider),
			listProviderSessionEventsPage(ctx, sessionId, agent.provider),
		]);
		return {
			session: toSession(session, agentId),
			events: eventPage.events,
			eventsNextPageToken: eventPage.eventsNextPageToken,
		};
	});
}

export async function deletePlaybookSession(input: DeletePlaybookSessionInput) {
	await withAgentRuntime(input.playbookId, async (ctx, compiled) => {
		const agent = getAgent(ctx, compiled.agentId);
		await deleteSession(ctx, input.sessionId, agent.provider);
	});
}

export async function sendPlaybookSessionMessage(input: SendPlaybookSessionInput) {
	return withAgentRuntime(input.playbookId, async (ctx, compiled) => {
		const agent = getAgent(ctx, compiled.agentId);
		await getSession(ctx, input.sessionId, agent.provider);
		const events = await sendSessionMessageStreaming(ctx, input.sessionId, input.message, {
			provider: agent.provider,
		});
		return { sessionId: input.sessionId, events };
	});
}

export function attachLiveStream(
	sessionId: string,
	events: AsyncIterable<ProviderSessionEvent>,
	seed: ProviderSessionEvent[],
) {
	createEventBuffer(sessionId, events, seed);
}

export function seedCompletedEvents(sessionId: string, events: ProviderSessionEvent[]) {
	seedCompletedBuffer(sessionId, events);
}
