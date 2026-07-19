import { getPlaybookAppId, getSeedPlaybookAgentName, PLAYBOOK_AGENT_NAME_PREFIX } from "@openagentpack/playbooks";
import {
	type CloudAgent,
	listCloudAgents,
	readProjectRuntime,
	resolveSessionProvider,
	startSessionRun,
} from "@openagentpack/sdk";
import { loadAgentRuntimeInput, withAgentRuntime } from "@/services/runtime-factory";
import { agentMetadataOf } from "./dto";
import { ensureAgentApplied } from "./provision";
import { createPlaybookSessionRuntime, type RemotePlaybookAgent } from "./runtime";
import {
	attachLiveStream,
	deletePlaybookSession,
	listPlaybookSessions,
	readProviderSessionDetail,
	seedCompletedEvents,
	sendPlaybookSessionMessage,
} from "./sessions";

export type { PlaybookSessionDetail } from "./sessions";

export function createServerPlaybookSessionRuntime() {
	return createPlaybookSessionRuntime({
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
				`\u73A9\u6CD5\u300C${playbookId}\u300D\u5339\u914D\u5230 ${all.length} \u4E2A active playbook Agent(${all
					.map((agent) => agent.id)
					.join(", ")})\uFF1B\u53D6\u6700\u8FD1\u66F4\u65B0\u7684 ${winner.id}\u3002`,
			);
		},
	});
}
