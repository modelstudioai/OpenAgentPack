import {
	createPlaybookSessionRuntime,
	getPlaybookAppId,
	getSeedPlaybookAgentName,
	PLAYBOOK_AGENT_NAME_PREFIX,
	type RemotePlaybookAgent,
} from "@openagentpack/playbooks";
import {
	type CloudAgent,
	listCloudAgents,
	type ProviderSessionEvent,
	readProjectRuntime,
	resolveSessionProvider,
	type Session,
	startSessionRun,
} from "@openagentpack/sdk";
import { loadAgentRuntimeInput, withAgentRuntime } from "@/services/runtime-factory";
import { agentMetadataOf } from "./dto";
import { ensureAgentApplied } from "./provision";
import {
	attachLiveStream,
	deletePlaybookSession,
	listPlaybookSessions,
	readProviderSessionDetail,
	seedCompletedEvents,
	sendPlaybookSessionMessage,
} from "./sessions";

export type { ModeAPlaybookSessionDetail } from "./sessions";

export function createModeAPlaybookSessionRuntime() {
	return createPlaybookSessionRuntime<ModeAPlaybookSessionDetail, ProviderSessionEvent, Session, RemotePlaybookAgent>({
		identity: {
			appId: getPlaybookAppId(),
			expectedAgentName: getSeedPlaybookAgentName,
		},
		agents: {
			async listPlaybookAgents(input) {
				const runtimeInput = await loadAgentRuntimeInput(input.playbookId);
				const provider = resolveSessionProvider(runtimeInput.agentId, runtimeInput.config);
				return readProjectRuntime(runtimeInput, (ctx) =>
					listCloudAgents(ctx, { provider, prefix: PLAYBOOK_AGENT_NAME_PREFIX }),
				) as Promise<RemotePlaybookAgent[]>;
			},
			async ensurePlaybookAgent(input) {
				return ensureAgentApplied(input.playbookId, input.model, input.matched as CloudAgent | undefined);
			},
		},
		sessions: {
			async list(input) {
				return listPlaybookSessions(input);
			},
			async start(input) {
				return withAgentRuntime(input.playbookId, async (ctx, compiled) => {
					const run = await startSessionRun(ctx, input.prompt, {
						agent: compiled.agentId,
						environmentId: input.environmentId,
						vaultIds: input.vaultIds,
						title: input.title ?? input.prompt.slice(0, 80),
						files: input.files,
						metadata: {
							"agents.webui": "true",
							...agentMetadataOf(compiled),
						},
					});
					return { sessionId: run.session.id, events: run.events };
				});
			},
			async send(input) {
				return sendPlaybookSessionMessage(input);
			},
			async delete(input) {
				return deletePlaybookSession(input);
			},
			async getDetail(input) {
				return readProviderSessionDetail(input.sessionId, input.playbookId);
			},
		},
		events: {
			attachLiveStream(sessionId, events, seed) {
				attachLiveStream(sessionId, events, seed ?? []);
			},
			seedCompleted(sessionId, events) {
				seedCompletedEvents(sessionId, events);
			},
		},
		onDuplicateAgent({ playbookId, winner, duplicates }) {
			const all = [winner, ...duplicates];
			console.warn(
				`玩法「${playbookId}」匹配到 ${all.length} 个 active playbook Agent(${all
					.map((agent) => agent.id)
					.join(", ")});取最近更新的 ${winner.id}。`,
			);
		},
	});
}

type ModeAPlaybookSessionDetail = import("./sessions").ModeAPlaybookSessionDetail;
