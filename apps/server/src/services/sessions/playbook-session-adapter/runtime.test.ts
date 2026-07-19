import { describe, expect, test } from "bun:test";
import { PLAYBOOK_APP_METADATA_KEY, PLAYBOOK_METADATA_KEY } from "@openagentpack/playbooks";
import type { ProviderSessionEvent, Session } from "@openagentpack/sdk";
import {
	createPlaybookSessionRuntime,
	PlaybookAgentIdentityMismatchError,
	pickPlaybookAgent,
	type RemotePlaybookAgent,
} from "./runtime";
import type { PlaybookSessionDetail } from "./sessions";

const APP_ID = "agents-webui";

function agent(overrides: Partial<RemotePlaybookAgent> = {}): RemotePlaybookAgent {
	return {
		id: "agent_1",
		name: "Agents/\u8BBE\u8BA1\u5E08\u52A9\u624B",
		metadata: {
			[PLAYBOOK_APP_METADATA_KEY]: APP_ID,
			[PLAYBOOK_METADATA_KEY]: "designer",
		},
		updatedAt: "2026-06-20T00:00:00.000Z",
		...overrides,
	};
}

function fakeEvent(raw_type = "created"): ProviderSessionEvent {
	return { type: "status", raw_type, raw: {} };
}

function fakeSession(id: string, agentId?: string): Session {
	return {
		session_id: id,
		status: "running",
		agent: agentId ? { agent_id: agentId } : undefined,
	};
}

function fakeDetail(sessionId: string, agentId?: string): PlaybookSessionDetail {
	return { session: fakeSession(sessionId, agentId), events: [] };
}

describe("pickPlaybookAgent", () => {
	test("picks the current-app playbook stamp by newest update time", () => {
		const older = agent({ id: "agent_old", updatedAt: "2026-06-20T00:00:00.000Z" });
		const newer = agent({ id: "agent_new", updatedAt: "2026-06-21T00:00:00.000Z" });

		const pick = pickPlaybookAgent([older, newer], { playbookId: "designer", appId: APP_ID });

		expect(pick.agent?.id).toBe("agent_new");
		expect(pick.duplicates.map((item) => item.id)).toEqual(["agent_old"]);
		expect(pick.identityMismatch).toBe(false);
	});

	test("blocks same-name current-app agents that are missing the playbook stamp", () => {
		const pick = pickPlaybookAgent(
			[
				agent({
					id: "agent_drifted",
					metadata: { [PLAYBOOK_APP_METADATA_KEY]: APP_ID },
				}),
			],
			{ playbookId: "designer", appId: APP_ID, expectedAgentName: "Agents/\u8BBE\u8BA1\u5E08\u52A9\u624B" },
		);

		expect(pick.agent).toBeUndefined();
		expect(pick.identityMismatch).toBe(true);
	});

	test("ignores archived agents unless explicitly requested", () => {
		const archived = agent({ archivedAt: "2026-06-22T00:00:00.000Z" });

		expect(pickPlaybookAgent([archived], { playbookId: "designer", appId: APP_ID }).agent).toBeUndefined();
		expect(pickPlaybookAgent([archived], { playbookId: "designer", appId: APP_ID, includeArchived: true }).agent).toBe(
			archived,
		);
	});
});

describe("createPlaybookSessionRuntime", () => {
	test("start ensures the selected agent, starts the provider session, attaches events, then returns detail", async () => {
		const calls: string[] = [];
		const liveEvents = (async function* () {
			yield fakeEvent();
		})();
		const runtime = createPlaybookSessionRuntime({
			identity: { appId: APP_ID, expectedAgentName: () => "Agents/\u8BBE\u8BA1\u5E08\u52A9\u624B" },
			agents: {
				async listPlaybookAgents() {
					calls.push("agents.list");
					return [agent({ id: "agent_existing" })];
				},
				async ensurePlaybookAgent(input) {
					calls.push(`agents.ensure:${input.matched?.id}:${input.model}`);
					return input.matched ?? agent({ id: "agent_created" });
				},
			},
			sessions: {
				async list() {
					throw new Error("should not list");
				},
				async start(input) {
					calls.push(`sessions.start:${input.remoteAgentId}:${input.prompt}`);
					return { sessionId: "sess_1", events: liveEvents };
				},
				async send() {
					throw new Error("should not send");
				},
				async delete() {
					throw new Error("should not delete");
				},
				async getDetail(input) {
					calls.push(`sessions.detail:${input.sessionId}:${input.remoteAgentId}`);
					return fakeDetail(input.sessionId, input.remoteAgentId);
				},
			},
			events: {
				attachLiveStream(sessionId) {
					calls.push(`events.attach:${sessionId}`);
				},
				seedCompleted(sessionId) {
					calls.push(`events.seed:${sessionId}`);
				},
			},
		});

		const detail = await runtime.start({
			playbookId: "designer",
			prompt: "hello",
			environmentId: "env_1",
			model: "glm-5.1",
		});

		expect(detail.session.session_id).toBe("sess_1");
		expect(detail.session.agent?.agent_id).toBe("agent_existing");
		expect(calls).toEqual([
			"agents.list",
			"agents.ensure:agent_existing:glm-5.1",
			"sessions.start:agent_existing:hello",
			"events.attach:sess_1",
			"sessions.detail:sess_1:agent_existing",
		]);
	});

	test("start throws before ensuring when identity is blocked", async () => {
		const runtime = createPlaybookSessionRuntime({
			identity: { appId: APP_ID, expectedAgentName: () => "Agents/\u8BBE\u8BA1\u5E08\u52A9\u624B" },
			agents: {
				async listPlaybookAgents() {
					return [agent({ metadata: { [PLAYBOOK_APP_METADATA_KEY]: APP_ID } })];
				},
				async ensurePlaybookAgent() {
					throw new Error("should not ensure");
				},
			},
			sessions: {
				async list() {
					throw new Error("should not list");
				},
				async start() {
					throw new Error("should not start");
				},
				async send() {
					throw new Error("should not send");
				},
				async delete() {
					throw new Error("should not delete");
				},
				async getDetail() {
					throw new Error("should not fetch detail");
				},
			},
		});

		await expect(
			runtime.start({ playbookId: "designer", prompt: "hello", environmentId: "env_1" }),
		).rejects.toBeInstanceOf(PlaybookAgentIdentityMismatchError);
	});

	test("send appends a message, attaches events, then returns detail", async () => {
		const calls: string[] = [];
		const liveEvents = (async function* () {
			yield fakeEvent("message");
		})();
		const runtime = createPlaybookSessionRuntime({
			identity: { appId: APP_ID },
			agents: {
				async listPlaybookAgents() {
					throw new Error("send should not resolve agents");
				},
				async ensurePlaybookAgent() {
					throw new Error("send should not ensure agents");
				},
			},
			sessions: {
				async list() {
					throw new Error("should not list");
				},
				async start() {
					throw new Error("should not start");
				},
				async send(input) {
					calls.push(`sessions.send:${input.sessionId}:${input.playbookId}:${input.message}`);
					return { sessionId: input.sessionId, events: liveEvents };
				},
				async delete() {
					throw new Error("should not delete");
				},
				async getDetail(input) {
					calls.push(`sessions.detail:${input.sessionId}:${input.playbookId}`);
					return fakeDetail(input.sessionId);
				},
			},
			events: {
				attachLiveStream(sessionId) {
					calls.push(`events.attach:${sessionId}`);
				},
				seedCompleted(sessionId) {
					calls.push(`events.seed:${sessionId}`);
				},
			},
		});

		const detail = await runtime.send({ playbookId: "designer", sessionId: "sess_1", message: "continue" });

		expect(detail.session.session_id).toBe("sess_1");
		expect(calls).toEqual([
			"sessions.send:sess_1:designer:continue",
			"events.attach:sess_1",
			"sessions.detail:sess_1:designer",
		]);
	});

	test("list reads sessions through the session adapter only", async () => {
		const calls: string[] = [];
		const runtime = createPlaybookSessionRuntime({
			identity: { appId: APP_ID },
			agents: {
				async listPlaybookAgents() {
					throw new Error("list should not resolve agents");
				},
				async ensurePlaybookAgent() {
					throw new Error("list should not ensure agents");
				},
			},
			sessions: {
				async list(input) {
					calls.push(`sessions.list:${input.playbookId}:${input.remoteAgentId}:${input.limit}:${input.pageToken}`);
					return { sessions: [fakeSession("sess_1")], nextPageToken: "next" };
				},
				async start() {
					throw new Error("should not start");
				},
				async send() {
					throw new Error("should not send");
				},
				async delete() {
					throw new Error("should not delete");
				},
				async getDetail() {
					throw new Error("list should not fetch detail");
				},
			},
		});

		const listed = await runtime.list({
			playbookId: "designer",
			remoteAgentId: "agent_1",
			limit: 10,
			pageToken: "page_1",
		});

		expect(listed.sessions[0]?.session_id).toBe("sess_1");
		expect(listed.nextPageToken).toBe("next");
		expect(calls).toEqual(["sessions.list:designer:agent_1:10:page_1"]);
	});

	test("getDetail reads through the session adapter only", async () => {
		const calls: string[] = [];
		const runtime = createPlaybookSessionRuntime({
			identity: { appId: APP_ID },
			agents: {
				async listPlaybookAgents() {
					throw new Error("getDetail should not resolve agents");
				},
				async ensurePlaybookAgent() {
					throw new Error("getDetail should not ensure agents");
				},
			},
			sessions: {
				async list() {
					throw new Error("should not list");
				},
				async start() {
					throw new Error("should not start");
				},
				async send() {
					throw new Error("should not send");
				},
				async delete() {
					throw new Error("should not delete");
				},
				async getDetail(input) {
					calls.push(`sessions.detail:${input.sessionId}:${input.playbookId}`);
					return fakeDetail(input.sessionId);
				},
			},
		});

		const detail = await runtime.getDetail({ playbookId: "designer", sessionId: "sess_1" });

		expect(detail.session.session_id).toBe("sess_1");
		expect(calls).toEqual(["sessions.detail:sess_1:designer"]);
	});

	test("delete removes a provider session through the session adapter only", async () => {
		const calls: string[] = [];
		const runtime = createPlaybookSessionRuntime({
			identity: { appId: APP_ID },
			agents: {
				async listPlaybookAgents() {
					throw new Error("delete should not resolve agents");
				},
				async ensurePlaybookAgent() {
					throw new Error("delete should not ensure agents");
				},
			},
			sessions: {
				async list() {
					throw new Error("should not list");
				},
				async start() {
					throw new Error("should not start");
				},
				async send() {
					throw new Error("should not send");
				},
				async delete(input) {
					calls.push(`sessions.delete:${input.sessionId}:${input.playbookId}`);
				},
				async getDetail() {
					throw new Error("delete should not fetch detail");
				},
			},
		});

		await runtime.delete({ playbookId: "designer", sessionId: "sess_1" });

		expect(calls).toEqual(["sessions.delete:sess_1:designer"]);
	});
});
