import {
	getAgent,
	getSession,
	isTerminalSessionStatus,
	listSessionEvents,
	type ProjectRuntimeContext,
	type ProviderSessionEvent,
	type ProviderSessionInfo,
	readProjectRuntime,
	resolveSessionProvider,
	type Session,
	streamSessionEvents,
	syncAgentResourcesWithStateBackend,
	UserError,
} from "@openagentpack/sdk";
import { DEFAULT_AGENT_ID, getSessionAgent } from "@/services/agents/catalog";
import { loadAgentRuntimeInput, withAgentRuntime } from "@/services/runtime-factory";
import {
	createServerPlaybookSessionRuntime,
	type PlaybookSessionDetail,
} from "@/services/sessions/playbook-session-adapter";
import { listProviderSessionEvents } from "@/services/sessions/playbook-session-adapter/sessions";

/**
 * Switch a provisioned playbook agent's model (the standalone updateAgent op). Recompiles the
 * agent decl with the new model and syncs the drift. No-op when the agent isn't provisioned
 * yet — the model then rides the next createSession via startSession's modelOverride.
 */
export async function updatePlaybookAgentModel(slug: string, model: string): Promise<void> {
	const input = await loadAgentRuntimeInput(slug, model);
	const provider = resolveSessionProvider(input.agentId, input.config);
	const applied = await readProjectRuntime(
		input,
		(ctx) => !!ctx.state.getResource({ type: "agent", name: input.agentId, provider })?.remote_id,
	);
	if (!applied) return;
	const run = await syncAgentResourcesWithStateBackend(input, input.agentId);
	if (run.status !== "completed") {
		throw new UserError(run.error ?? `Failed to update agent '${input.agentId}' model (status: ${run.status}).`);
	}
}

import { createEventBuffer, seedCompletedBuffer } from "@/services/sessions/event-buffer";

/** A session plus its raw provider events (events are mapped to the contract at the route boundary). */
export type SessionWithEvents = PlaybookSessionDetail;

const playbookSessionRuntime = createServerPlaybookSessionRuntime();

export async function listSessionsForAgent(input: {
	agentId?: string;
	limit?: number;
	pageToken?: string;
}): Promise<{ sessions: Session[]; nextPageToken?: string }> {
	const requestedAgentId = input.agentId?.trim() || undefined;
	const limit = input.limit ?? 50;
	const page = input.pageToken?.trim() || undefined;
	// A raw remote agent id ("agent_…") is not a catalog playbook, so it can't drive a runtime
	// context. Resolve runtime via the default playbook purely to obtain a provider, then filter
	// sessions by the remote id directly. The resource view uses this to scope sessions to the
	// Agents agent family (one call per real agent id) — the backend's only session filter is
	// agent_id, so there is no project-wide listing to lean on.
	const remoteAgentId = requestedAgentId?.startsWith("agent_") ? requestedAgentId : undefined;
	return playbookSessionRuntime.list({
		playbookId: requestedAgentId && !remoteAgentId ? requestedAgentId : undefined,
		remoteAgentId,
		limit,
		pageToken: page,
	});
}

export async function getSessionDetail(sessionId: string, agentId = DEFAULT_AGENT_ID): Promise<SessionWithEvents> {
	// agentId may be a remote provider agent ID (e.g. "agent_01K...") rather than a
	// catalog ID (e.g. "bailian-cli"). Resolve to a valid catalog agent for runtime
	// context while preserving the original agentId for the response.
	const catalogAgentId = getSessionAgent(agentId) ? agentId : DEFAULT_AGENT_ID;
	return playbookSessionRuntime.getDetail({ playbookId: catalogAgentId, sessionId });
}

export async function listSessionEventsPage(
	sessionId: string,
	agentId?: string,
	pageToken?: string,
	limit?: number,
): Promise<{ events: ProviderSessionEvent[]; eventsNextPageToken?: string }> {
	return listProviderSessionEvents(sessionId, agentId, pageToken, limit);
}

export async function startSession(input: {
	agentId?: string;
	prompt: string;
	title?: string;
	/** Cloud sandbox id; every session runs inside an environment. */
	environmentId: string;
	vaultIds?: string[];
	files?: { fileId: string; mountPath: string }[];
	model?: string;
}): Promise<SessionWithEvents> {
	const agentId = input.agentId?.trim() || DEFAULT_AGENT_ID;
	return playbookSessionRuntime.start({
		playbookId: agentId,
		prompt: input.prompt,
		environmentId: input.environmentId,
		title: input.title,
		vaultIds: input.vaultIds,
		files: input.files,
		model: input.model?.trim() || undefined,
	});
}

export async function sendMessage(
	sessionId: string,
	message: string,
	agentId = DEFAULT_AGENT_ID,
): Promise<SessionWithEvents> {
	const catalogAgentId = getSessionAgent(agentId) ? agentId : DEFAULT_AGENT_ID;
	return playbookSessionRuntime.send({
		playbookId: catalogAgentId,
		sessionId,
		message,
	});
}

export async function deleteSession(sessionId: string, agentId = DEFAULT_AGENT_ID): Promise<void> {
	const catalogAgentId = getSessionAgent(agentId) ? agentId : DEFAULT_AGENT_ID;
	await playbookSessionRuntime.delete({ playbookId: catalogAgentId, sessionId });
}

/**
 * Rebuild an in-memory event buffer for a session that has no live buffer (server restart,
 * eviction, or a second client connecting). Terminal sessions are seeded from history and
 * marked done; running sessions seed history and attach the provider's native event stream
 * (de-duplicated by event id). Returns false when the session can't be resolved.
 */
export async function reconstructSessionBuffer(sessionId: string): Promise<boolean> {
	return withAgentRuntime(DEFAULT_AGENT_ID, async (ctx, compiled) => {
		const provider = getAgent(ctx, compiled.agentId).provider;
		let session: ProviderSessionInfo;
		try {
			session = await getSession(ctx, sessionId, provider);
		} catch {
			return false;
		}
		const history = await listAllSessionEvents(ctx, sessionId, provider);
		if (isTerminalSessionStatus(session.status)) {
			seedCompletedBuffer(sessionId, history);
		} else {
			createEventBuffer(sessionId, streamSessionEvents(ctx, sessionId, { provider }), history);
		}
		return true;
	});
}

async function listAllSessionEvents(
	ctx: ProjectRuntimeContext,
	sessionId: string,
	provider: string,
): Promise<ProviderSessionEvent[]> {
	const all: ProviderSessionEvent[] = [];
	let page: string | undefined;
	for (let i = 0; i < 50; i++) {
		const { events, has_more, next_page } = await listSessionEvents(ctx, sessionId, {
			provider,
			limit: 200,
			page_token: page,
		});
		all.push(...events);
		if (!has_more || !next_page) break;
		page = next_page;
	}
	return all;
}
