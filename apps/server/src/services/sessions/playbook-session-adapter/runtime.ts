/**
 * Session runtime: agent-pick logic + orchestration for playbook sessions.
 *
 * Previously lived in `@openagentpack/playbooks/session-runtime`; inlined here
 * because the server is the only production consumer. The adapter interface
 * layer is replaced by a concrete dependency-injection object so orchestration
 * remains unit-testable without cross-module mocking.
 */
import { PLAYBOOK_APP_METADATA_KEY, PLAYBOOK_METADATA_KEY } from "@openagentpack/playbooks";
import type { ProviderSessionEvent, Session } from "@openagentpack/sdk";
import type { PlaybookSessionDetail } from "./sessions";

// ---------------------------------------------------------------------------
// Input / output types (previously exported from @openagentpack/playbooks)
// ---------------------------------------------------------------------------

export type MaybePromise<T> = T | Promise<T>;

export type PlaybookSessionFile = { fileId: string; mountPath: string };

export type StartPlaybookSessionInput = {
	playbookId: string;
	prompt: string;
	title?: string;
	/** Cloud sandbox id; every session runs inside an environment. */
	environmentId: string;
	vaultIds?: string[];
	files?: PlaybookSessionFile[];
	model?: string;
};

export type ProviderStartPlaybookSessionInput = StartPlaybookSessionInput & {
	remoteAgentId: string;
};

export type StartedProviderPlaybookSession = {
	sessionId: string;
	events?: AsyncIterable<ProviderSessionEvent>;
	completedEvents?: ProviderSessionEvent[];
};

export type SendPlaybookSessionInput = {
	playbookId: string;
	sessionId: string;
	message: string;
};

export type DeletePlaybookSessionInput = {
	playbookId: string;
	sessionId: string;
};

export type GetPlaybookSessionDetailInput = {
	playbookId: string;
	sessionId: string;
};

export type ListPlaybookSessionsInput = {
	playbookId?: string;
	remoteAgentId?: string;
	limit?: number;
	pageToken?: string;
};

export type PlaybookSessionList = {
	sessions: Session[];
	nextPageToken?: string;
};

export type SentProviderPlaybookMessage = {
	sessionId: string;
	events?: AsyncIterable<ProviderSessionEvent>;
	completedEvents?: ProviderSessionEvent[];
};

// ---------------------------------------------------------------------------
// Remote agent types
// ---------------------------------------------------------------------------

export type RemotePlaybookAgent = {
	id: string;
	name?: string;
	metadata?: Record<string, string>;
	version?: string | number;
	updatedAt?: string | number | null;
	updated_at?: string | number | null;
	archivedAt?: string | number | null;
	archived_at?: string | number | null;
};

export type PlaybookAgentPick = {
	agent: RemotePlaybookAgent | undefined;
	duplicates: RemotePlaybookAgent[];
	identityMismatch: boolean;
};

// ---------------------------------------------------------------------------
// Identity-mismatch error
// ---------------------------------------------------------------------------

export function playbookIdentityMismatchMessage(playbookId: string): string {
	return `\u73A9\u6CD5\u300C${playbookId}\u300D\u5B58\u5728\u540C\u5E94\u7528\u540C\u540D Agent\uFF0C\u4F46 metadata.${PLAYBOOK_APP_METADATA_KEY}/${PLAYBOOK_METADATA_KEY} \u672A\u5BF9\u4E0A\uFF0C\u7591\u4F3C\u8EAB\u4EFD\u672A\u76D6\u7AE0\uFF1B\u8BF7\u68C0\u67E5\u914D\u7F6E\u800C\u975E\u91CD\u590D\u521B\u5EFA\u3002`;
}

export class PlaybookAgentIdentityMismatchError extends Error {
	constructor(playbookId: string) {
		super(playbookIdentityMismatchMessage(playbookId));
		this.name = "PlaybookAgentIdentityMismatchError";
	}
}

// ---------------------------------------------------------------------------
// pickPlaybookAgent — pure function, directly testable
// ---------------------------------------------------------------------------

export function pickPlaybookAgent(
	agents: RemotePlaybookAgent[],
	input: { playbookId: string; appId: string; expectedAgentName?: string; includeArchived?: boolean },
): PlaybookAgentPick {
	const matched = agents.filter(
		(agent) =>
			(input.includeArchived || !isArchived(agent)) &&
			agent.metadata?.[PLAYBOOK_APP_METADATA_KEY] === input.appId &&
			agent.metadata?.[PLAYBOOK_METADATA_KEY] === input.playbookId,
	);
	if (matched.length <= 1) {
		return {
			agent: matched[0],
			duplicates: [],
			identityMismatch: matched.length === 0 && hasSameNameCurrentAppAgent(agents, input),
		};
	}
	const sorted = [...matched].sort((a, b) => epochOf(updatedAtOf(b)) - epochOf(updatedAtOf(a)));
	const [agent, ...duplicates] = sorted;
	return { agent, duplicates, identityMismatch: false };
}

// ---------------------------------------------------------------------------
// Dependency contract (concrete types, no generics)
// ---------------------------------------------------------------------------

export type PlaybookSessionRuntimeDeps = {
	identity: {
		appId: string;
		expectedAgentName?: (playbookId: string) => MaybePromise<string | undefined>;
	};
	agents: {
		listPlaybookAgents(input: { playbookId: string; includeArchived: boolean }): Promise<RemotePlaybookAgent[]>;
		ensurePlaybookAgent(input: {
			playbookId: string;
			model?: string;
			matched?: RemotePlaybookAgent;
		}): Promise<RemotePlaybookAgent>;
	};
	sessions: {
		list(input: ListPlaybookSessionsInput): Promise<PlaybookSessionList>;
		start(input: ProviderStartPlaybookSessionInput): Promise<StartedProviderPlaybookSession>;
		send(input: SendPlaybookSessionInput): Promise<SentProviderPlaybookMessage>;
		delete(input: DeletePlaybookSessionInput): Promise<void>;
		getDetail(input: { sessionId: string; playbookId: string; remoteAgentId?: string }): Promise<PlaybookSessionDetail>;
	};
	events?: {
		attachLiveStream(
			sessionId: string,
			events: AsyncIterable<ProviderSessionEvent>,
			seed?: ProviderSessionEvent[],
		): void;
		seedCompleted(sessionId: string, events: ProviderSessionEvent[]): void;
	};
	onDuplicateAgent?: (input: {
		playbookId: string;
		winner: RemotePlaybookAgent;
		duplicates: RemotePlaybookAgent[];
	}) => void;
};

// ---------------------------------------------------------------------------
// Runtime interface
// ---------------------------------------------------------------------------

export interface PlaybookSessionRuntime {
	list(input: ListPlaybookSessionsInput): Promise<PlaybookSessionList>;
	getDetail(input: GetPlaybookSessionDetailInput): Promise<PlaybookSessionDetail>;
	start(input: StartPlaybookSessionInput): Promise<PlaybookSessionDetail>;
	send(input: SendPlaybookSessionInput): Promise<PlaybookSessionDetail>;
	delete(input: DeletePlaybookSessionInput): Promise<void>;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createPlaybookSessionRuntime(deps: PlaybookSessionRuntimeDeps): PlaybookSessionRuntime {
	async function findAgent(playbookId: string): Promise<PlaybookAgentPick> {
		const [agents, expectedAgentName] = await Promise.all([
			deps.agents.listPlaybookAgents({ playbookId, includeArchived: false }),
			deps.identity.expectedAgentName?.(playbookId),
		]);
		return pickPlaybookAgent(agents, {
			playbookId,
			appId: deps.identity.appId,
			expectedAgentName,
		});
	}

	return {
		async list(input) {
			return deps.sessions.list(input);
		},

		async getDetail(input) {
			return deps.sessions.getDetail(input);
		},

		async start(input) {
			const pick = await findAgent(input.playbookId);
			if (pick.identityMismatch) throw new PlaybookAgentIdentityMismatchError(input.playbookId);
			if (pick.agent && pick.duplicates.length) {
				deps.onDuplicateAgent?.({ playbookId: input.playbookId, winner: pick.agent, duplicates: pick.duplicates });
			}
			const agent = await deps.agents.ensurePlaybookAgent({
				playbookId: input.playbookId,
				model: input.model,
				matched: pick.agent,
			});
			const started = await deps.sessions.start({ ...input, remoteAgentId: agent.id });
			if (started.events) {
				deps.events?.attachLiveStream(started.sessionId, started.events, started.completedEvents);
			} else if (started.completedEvents?.length) {
				deps.events?.seedCompleted(started.sessionId, started.completedEvents);
			}
			return deps.sessions.getDetail({
				sessionId: started.sessionId,
				playbookId: input.playbookId,
				remoteAgentId: agent.id,
			});
		},

		async send(input) {
			const sent = await deps.sessions.send(input);
			if (sent.events) {
				deps.events?.attachLiveStream(sent.sessionId, sent.events, sent.completedEvents);
			} else if (sent.completedEvents?.length) {
				deps.events?.seedCompleted(sent.sessionId, sent.completedEvents);
			}
			return deps.sessions.getDetail({
				sessionId: sent.sessionId,
				playbookId: input.playbookId,
			});
		},

		async delete(input) {
			await deps.sessions.delete(input);
		},
	};
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function hasSameNameCurrentAppAgent(
	agents: RemotePlaybookAgent[],
	input: { appId: string; expectedAgentName?: string },
): boolean {
	if (!input.expectedAgentName) return false;
	return agents.some(
		(agent) =>
			!isArchived(agent) &&
			agent.metadata?.[PLAYBOOK_APP_METADATA_KEY] === input.appId &&
			agent.name === input.expectedAgentName,
	);
}

function isArchived(agent: RemotePlaybookAgent): boolean {
	return agent.archivedAt != null || agent.archived_at != null;
}

function updatedAtOf(agent: RemotePlaybookAgent): string | number | null | undefined {
	return agent.updatedAt ?? agent.updated_at;
}

function epochOf(value: string | number | null | undefined): number {
	if (value == null) return 0;
	if (typeof value === "number") return value;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? 0 : parsed;
}
