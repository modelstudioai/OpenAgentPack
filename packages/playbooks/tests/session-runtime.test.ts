import { describe, expect, test } from "bun:test";
import {
	createPlaybookSessionRuntime,
	PLAYBOOK_APP_METADATA_KEY,
	PLAYBOOK_METADATA_KEY,
	PlaybookAgentIdentityMismatchError,
	pickPlaybookAgent,
	playbookIdentityMismatchMessage,
	type RemotePlaybookAgent,
	readinessFromPick,
} from "../src/index.ts";

const APP_ID = "agents-webui";

function agent(overrides: Partial<RemotePlaybookAgent> = {}): RemotePlaybookAgent {
	return {
		id: "agent_1",
		name: "Agents/设计师助手",
		metadata: {
			[PLAYBOOK_APP_METADATA_KEY]: APP_ID,
			[PLAYBOOK_METADATA_KEY]: "designer",
		},
		updatedAt: "2026-06-20T00:00:00.000Z",
		...overrides,
	};
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
			{ playbookId: "designer", appId: APP_ID, expectedAgentName: "Agents/设计师助手" },
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

describe("readinessFromPick", () => {
	test("a matched agent is ready and carries its remote id", () => {
		const pick = pickPlaybookAgent([agent({ id: "agent_ready" })], { playbookId: "designer", appId: APP_ID });

		expect(readinessFromPick(pick, "designer")).toEqual({
			status: "ready",
			playbookId: "designer",
			remoteAgentId: "agent_ready",
		});
	});

	test("no candidate is missing/not_provisioned", () => {
		const pick = pickPlaybookAgent([], { playbookId: "designer", appId: APP_ID });

		expect(readinessFromPick(pick, "designer")).toEqual({
			status: "missing",
			playbookId: "designer",
			reason: "not_provisioned",
		});
	});

	test("a same-name unstamped agent is blocked with the shared mismatch message", () => {
		const pick = pickPlaybookAgent([agent({ metadata: { [PLAYBOOK_APP_METADATA_KEY]: APP_ID } })], {
			playbookId: "designer",
			appId: APP_ID,
			expectedAgentName: "Agents/设计师助手",
		});

		expect(readinessFromPick(pick, "designer")).toEqual({
			status: "blocked",
			playbookId: "designer",
			reason: "identity_mismatch",
			message: playbookIdentityMismatchMessage("designer"),
		});
	});
});

describe("createPlaybookSessionRuntime", () => {
	test("start ensures the selected agent, starts the provider session, attaches events, then returns detail", async () => {
		const calls: string[] = [];
		const liveEvents = (async function* () {
			yield { type: "created" };
		})();
		const runtime = createPlaybookSessionRuntime({
			identity: { appId: APP_ID, expectedAgentName: () => "Agents/设计师助手" },
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
					return { sessionId: input.sessionId, agentId: input.remoteAgentId };
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

		expect(detail).toEqual({ sessionId: "sess_1", agentId: "agent_existing" });
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
			identity: { appId: APP_ID, expectedAgentName: () => "Agents/设计师助手" },
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
			yield { type: "message" };
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
					return { sessionId: input.sessionId, playbookId: input.playbookId };
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

		expect(detail).toEqual({ sessionId: "sess_1", playbookId: "designer" });
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
					return { sessions: [{ id: "sess_1" }], nextPageToken: "next" };
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

		expect(listed).toEqual({ sessions: [{ id: "sess_1" }], nextPageToken: "next" });
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
					return { sessionId: input.sessionId, playbookId: input.playbookId };
				},
			},
		});

		const detail = await runtime.getDetail({ playbookId: "designer", sessionId: "sess_1" });

		expect(detail).toEqual({ sessionId: "sess_1", playbookId: "designer" });
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
