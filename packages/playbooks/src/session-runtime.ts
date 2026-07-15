import { PLAYBOOK_APP_METADATA_KEY, PLAYBOOK_METADATA_KEY } from "./metadata.ts";

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

export type StartedProviderPlaybookSession<TEvent> = {
	sessionId: string;
	events?: AsyncIterable<TEvent>;
	completedEvents?: TEvent[];
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

export type PlaybookSessionList<TSession> = {
	sessions: TSession[];
	nextPageToken?: string;
};

export type SentProviderPlaybookMessage<TEvent> = {
	sessionId: string;
	events?: AsyncIterable<TEvent>;
	completedEvents?: TEvent[];
};

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

export type PlaybookAgentPick<TAgent extends RemotePlaybookAgent> = {
	agent: TAgent | undefined;
	duplicates: TAgent[];
	identityMismatch: boolean;
};

export type PlaybookReadiness =
	| { status: "ready"; playbookId: string; remoteAgentId: string }
	| { status: "missing"; playbookId: string; reason: "not_provisioned" }
	| { status: "unknown"; playbookId: string; reason: "not_checked" | "check_failed" }
	| { status: "blocked"; playbookId: string; reason: "identity_mismatch"; message: string };

export interface PlaybookAgentAdapter<TAgent extends RemotePlaybookAgent = RemotePlaybookAgent> {
	listPlaybookAgents(input: { playbookId: string; includeArchived: boolean }): Promise<TAgent[]>;
	ensurePlaybookAgent(input: { playbookId: string; model?: string; matched?: TAgent }): Promise<TAgent>;
}

export interface PlaybookProviderSessionAdapter<TDetail, TEvent, TSession = unknown> {
	list(input: ListPlaybookSessionsInput): Promise<PlaybookSessionList<TSession>>;
	start(input: ProviderStartPlaybookSessionInput): Promise<StartedProviderPlaybookSession<TEvent>>;
	send(input: SendPlaybookSessionInput): Promise<SentProviderPlaybookMessage<TEvent>>;
	delete(input: DeletePlaybookSessionInput): Promise<void>;
	getDetail(input: { sessionId: string; playbookId: string; remoteAgentId?: string }): Promise<TDetail>;
}

export interface PlaybookSessionEventsAdapter<TEvent> {
	attachLiveStream(sessionId: string, events: AsyncIterable<TEvent>, seed?: TEvent[]): void;
	seedCompleted(sessionId: string, events: TEvent[]): void;
}

export interface PlaybookSessionRuntime<TDetail, TSession = unknown> {
	list(input: ListPlaybookSessionsInput): Promise<PlaybookSessionList<TSession>>;
	getDetail(input: GetPlaybookSessionDetailInput): Promise<TDetail>;
	start(input: StartPlaybookSessionInput): Promise<TDetail>;
	send(input: SendPlaybookSessionInput): Promise<TDetail>;
	delete(input: DeletePlaybookSessionInput): Promise<void>;
}

export type PlaybookSessionRuntimeAdapters<
	TDetail,
	TEvent = unknown,
	TSession = unknown,
	TAgent extends RemotePlaybookAgent = RemotePlaybookAgent,
> = {
	identity: {
		appId: string;
		expectedAgentName?: (playbookId: string) => MaybePromise<string | undefined>;
	};
	agents: PlaybookAgentAdapter<TAgent>;
	sessions: PlaybookProviderSessionAdapter<TDetail, TEvent, TSession>;
	events?: PlaybookSessionEventsAdapter<TEvent>;
	onDuplicateAgent?: (input: { playbookId: string; winner: TAgent; duplicates: TAgent[] }) => void;
};

// Single source of the identity-mismatch copy, shared by the runtime error, the
// readiness mapping, and Mode B's resolver throw.
export function playbookIdentityMismatchMessage(playbookId: string): string {
	return `玩法「${playbookId}」存在同应用同名 Agent，但 metadata.${PLAYBOOK_APP_METADATA_KEY}/${PLAYBOOK_METADATA_KEY} 未对上，疑似身份未盖章；请检查配置而非重复创建。`;
}

export class PlaybookAgentIdentityMismatchError extends Error {
	constructor(playbookId: string) {
		super(playbookIdentityMismatchMessage(playbookId));
		this.name = "PlaybookAgentIdentityMismatchError";
	}
}

export function pickPlaybookAgent<TAgent extends RemotePlaybookAgent>(
	agents: TAgent[],
	input: { playbookId: string; appId: string; expectedAgentName?: string; includeArchived?: boolean },
): PlaybookAgentPick<TAgent> {
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

// The single source of the pick→PlaybookReadiness mapping, shared by the per-id runtime
// path and Mode B's first-screen batch prime, so identity-drift handling lives in one place.
export function readinessFromPick<TAgent extends RemotePlaybookAgent>(
	pick: PlaybookAgentPick<TAgent>,
	playbookId: string,
): PlaybookReadiness {
	if (pick.identityMismatch) {
		return {
			status: "blocked",
			playbookId,
			reason: "identity_mismatch",
			message: playbookIdentityMismatchMessage(playbookId),
		};
	}
	if (!pick.agent) return { status: "missing", playbookId, reason: "not_provisioned" };
	return { status: "ready", playbookId, remoteAgentId: pick.agent.id };
}

export function createPlaybookSessionRuntime<
	TDetail,
	TEvent = unknown,
	TSession = unknown,
	TAgent extends RemotePlaybookAgent = RemotePlaybookAgent,
>(
	adapters: PlaybookSessionRuntimeAdapters<TDetail, TEvent, TSession, TAgent>,
): PlaybookSessionRuntime<TDetail, TSession> {
	async function findAgent(playbookId: string): Promise<PlaybookAgentPick<TAgent>> {
		const [agents, expectedAgentName] = await Promise.all([
			adapters.agents.listPlaybookAgents({ playbookId, includeArchived: false }),
			adapters.identity.expectedAgentName?.(playbookId),
		]);
		return pickPlaybookAgent(agents, {
			playbookId,
			appId: adapters.identity.appId,
			expectedAgentName,
		});
	}

	return {
		async list(input) {
			return adapters.sessions.list(input);
		},

		async getDetail(input) {
			return adapters.sessions.getDetail(input);
		},

		async start(input) {
			const pick = await findAgent(input.playbookId);
			if (pick.identityMismatch) throw new PlaybookAgentIdentityMismatchError(input.playbookId);
			if (pick.agent && pick.duplicates.length) {
				adapters.onDuplicateAgent?.({ playbookId: input.playbookId, winner: pick.agent, duplicates: pick.duplicates });
			}
			const agent = await adapters.agents.ensurePlaybookAgent({
				playbookId: input.playbookId,
				model: input.model,
				matched: pick.agent,
			});
			const started = await adapters.sessions.start({ ...input, remoteAgentId: agent.id });
			if (started.events) {
				adapters.events?.attachLiveStream(started.sessionId, started.events, started.completedEvents);
			} else if (started.completedEvents?.length) {
				adapters.events?.seedCompleted(started.sessionId, started.completedEvents);
			}
			return adapters.sessions.getDetail({
				sessionId: started.sessionId,
				playbookId: input.playbookId,
				remoteAgentId: agent.id,
			});
		},

		async send(input) {
			const sent = await adapters.sessions.send(input);
			if (sent.events) {
				adapters.events?.attachLiveStream(sent.sessionId, sent.events, sent.completedEvents);
			} else if (sent.completedEvents?.length) {
				adapters.events?.seedCompleted(sent.sessionId, sent.completedEvents);
			}
			return adapters.sessions.getDetail({
				sessionId: sent.sessionId,
				playbookId: input.playbookId,
			});
		},

		async delete(input) {
			await adapters.sessions.delete(input);
		},
	};
}

function hasSameNameCurrentAppAgent<TAgent extends RemotePlaybookAgent>(
	agents: TAgent[],
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
