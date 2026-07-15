// @ts-nocheck
import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
// schemas/sessions.ts calls `.openapi()` on the @openagentpack/sdk core schemas at module-eval time. That
// method is added to zod's prototype as a side effect of importing @hono/zod-openapi, so the core
// schemas must be built on the SAME zod instance @hono/zod-openapi patched. IMPORTANT: do NOT
// `mock.module("@openagentpack/sdk", …)` — under `bun test` that re-evaluates the SDK (and its zod) onto a
// SEPARATE, unpatched instance, so `.openapi` goes missing and the session routes fail to load. Stub
// the one SDK function we need with `spyOn(actualCore, …)` (below) instead. The named import + guard
// also keep the side-effecting @hono/zod-openapi module from being tree-shaken away under `bun test`.
import { z as zWithOpenApi } from "@hono/zod-openapi";
import { getPlaybookAppId, PLAYBOOK_APP_METADATA_KEY, PLAYBOOK_METADATA_KEY } from "@openagentpack/playbooks";
import * as actualCore from "@openagentpack/sdk";

if (typeof (zWithOpenApi.string() as { openapi?: unknown }).openapi !== "function") {
	throw new Error("@hono/zod-openapi did not patch zod with .openapi");
}

const calls = {
	listSessionsForAgent: [] as unknown[],
	getSessionDetail: [] as unknown[],
	listSessionEventsPage: [] as unknown[],
	startSession: [] as unknown[],
	sendMessage: [] as unknown[],
	deleteSession: [] as unknown[],
	updatePlaybookAgentModel: [] as unknown[],
	listAgentsWithReadiness: [] as unknown[],
	listCloudAgents: [] as unknown[],
};

const state = {
	listSessionsForAgent: async () => ({ sessions: [sampleSession()], nextPageToken: undefined }),
	getSessionDetail: async () => ({ session: sampleSession(), events: [sampleProviderEvent()] }),
	listSessionEventsPage: async () => ({ events: [sampleProviderEvent()], eventsNextPageToken: undefined }),
	startSession: async () => ({
		session: sampleSession({ session_id: "created", title: "created session" }),
		events: [sampleProviderEvent()],
	}),
	sendMessage: async () => ({ session: sampleSession({ title: "follow-up" }), events: [sampleProviderEvent()] }),
	deleteSession: async () => undefined,
	updatePlaybookAgentModel: async () => undefined,
	listAgentsWithReadiness: async () => [
		{
			agent: { id: "bailian-cli" },
			readiness: { status: "ready", agentId: "bailian-cli", diagnostics: [], missing: [], plannedActions: [] },
		},
	],
	listCloudAgents: async () => [sampleCloudAgent()],
};

mock.module("@/services/sessions/runner", () => ({
	listSessionsForAgent: async (...args: unknown[]) => {
		calls.listSessionsForAgent.push(args);
		return state.listSessionsForAgent(...args);
	},
	getSessionDetail: async (...args: unknown[]) => {
		calls.getSessionDetail.push(args);
		return state.getSessionDetail(...args);
	},
	listSessionEventsPage: async (...args: unknown[]) => {
		calls.listSessionEventsPage.push(args);
		return state.listSessionEventsPage(...args);
	},
	startSession: async (...args: unknown[]) => {
		calls.startSession.push(args);
		return state.startSession(...args);
	},
	sendMessage: async (...args: unknown[]) => {
		calls.sendMessage.push(args);
		return state.sendMessage(...args);
	},
	deleteSession: async (...args: unknown[]) => {
		calls.deleteSession.push(args);
		return state.deleteSession(...args);
	},
	updatePlaybookAgentModel: async (...args: unknown[]) => {
		calls.updatePlaybookAgentModel.push(args);
		return state.updatePlaybookAgentModel(...args);
	},
	reconstructSessionBuffer: async () => false,
}));

mock.module("@/services/runtime-factory", () => ({
	loadServerRuntimeConfig: async () => ({
		projectName: "project",
		config: {},
		stateBackend: {},
		stateScope: { projectId: "project" },
	}),
	loadAgentRuntimeInput: async (agentId: string) => ({
		projectName: "project",
		config: {},
		stateBackend: {},
		stateScope: { projectId: "project" },
		agentId,
	}),
	withAgentRuntime: async (agentId: string, fn: (ctx: unknown, compiled: unknown) => unknown) => {
		globalThis.__withAgentRuntimeCalls ??= [];
		globalThis.__withAgentRuntimeCalls.push([agentId]);
		return fn(
			{ configPath: "/tmp/agents.yaml" },
			{ agentId, agent: { id: agentId, version: "1" }, agentConfigHash: "h" },
		);
	},
}));

// Stub the single SDK function the agents route calls. Using spyOn (not mock.module) keeps
// @openagentpack/sdk on one zod instance so schemas/sessions.ts can attach OpenAPI names (see top note).
spyOn(actualCore, "listAgentsWithReadiness").mockImplementation(async (...args: unknown[]) => {
	calls.listAgentsWithReadiness.push(args);
	return state.listAgentsWithReadiness(...args);
});

spyOn(actualCore, "listCloudAgents").mockImplementation(async (...args: unknown[]) => {
	calls.listCloudAgents.push(args);
	return state.listCloudAgents(...args);
});

// Import Hono routes (they use the mocked @/services/* and @openagentpack/sdk modules above)
const { agentsRoute: agentsApp } = await import("../src/routes/agents");
const { sessionsRoute: sessionsApp } = await import("../src/routes/sessions");

describe("API routes", () => {
	beforeEach(() => {
		for (const key of Object.keys(calls)) calls[key].length = 0;
		globalThis.__withAgentRuntimeCalls = [];
		state.listSessionsForAgent = async () => ({ sessions: [sampleSession()], nextPageToken: undefined });
		state.getSessionDetail = async () => ({ session: sampleSession(), events: [sampleProviderEvent()] });
		state.listSessionEventsPage = async () => ({ events: [sampleProviderEvent()], eventsNextPageToken: undefined });
		state.startSession = async () => ({
			session: sampleSession({ session_id: "created", title: "created session" }),
			events: [sampleProviderEvent()],
		});
		state.sendMessage = async () => ({
			session: sampleSession({ title: "follow-up" }),
			events: [sampleProviderEvent()],
		});
		state.deleteSession = async () => undefined;
		state.updatePlaybookAgentModel = async () => undefined;
		state.listAgentsWithReadiness = async () => [
			{
				agent: { id: "bailian-cli" },
				readiness: { status: "ready", agentId: "bailian-cli", diagnostics: [], missing: [], plannedActions: [] },
			},
		];
		state.ensureAgentReady = async () => ({ agentId: "bailian-cli", status: "completed", results: [] });
		state.listCloudAgents = async () => [sampleCloudAgent()];
	});

	test("GET /api/sessions returns the snake_case session list", async () => {
		const response = await sessionsApp.request("/sessions?agentId=agent-a&limit=7");
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(calls.listSessionsForAgent).toEqual([[{ agentId: "agent-a", limit: 7 }]]);
		expect(body.data[0].session_id).toBe("sesn_1");
		// The list endpoint carries sessions only — events are not part of the list shape.
		expect(body.data[0].events).toBeUndefined();
	});

	test("GET /api/sessions clamps invalid limits to the default", async () => {
		const response = await sessionsApp.request("/sessions?limit=bad");
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(calls.listSessionsForAgent).toEqual([[{ agentId: undefined, limit: 50 }]]);
		expect(body.data[0].session_id).toBe("sesn_1");
	});

	test("GET /api/sessions/:sessionId returns a sanitized session with events", async () => {
		const response = await sessionsApp.request("/sessions/session-1?agentId=agent-a");
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(calls.getSessionDetail).toEqual([["session-1", "agent-a"]]);
		expect(body.session.session_id).toBe("sesn_1");
		// Original Agents type is preserved as the contract event `type` (no 22→7 reduction here).
		expect(body.events[0].type).toBe("tool_call_output");
		expect(body.events[0].content[0].text).toContain("[redacted]");
		expect(body.events[0].content[0].text).not.toContain("secret-signature");
		expect(body.events[0].metadata.redacted).toBe(true);
		// Raw is stripped unless explicitly requested in debug mode.
		expect(body.events[0].metadata.raw).toBeUndefined();
	});

	test("GET /api/sessions/:sessionId?debug=1 surfaces sanitized raw outside production", async () => {
		const originalEnv = process.env.NODE_ENV;
		process.env.NODE_ENV = "development";

		const response = await sessionsApp.request("/sessions/session-1?debug=1");
		const body = await response.json();

		process.env.NODE_ENV = originalEnv;
		expect(response.status).toBe(200);
		expect(body.events[0].metadata.raw).toBeDefined();
		expect(JSON.stringify(body.events[0].metadata.raw)).toContain("[redacted]");
		expect(JSON.stringify(body.events[0].metadata.raw)).not.toContain("secret-signature");
	});

	test("POST /api/sessions validates required fields", async () => {
		const response = await sessionsApp.request("/sessions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ agentId: "bailian-cli", prompt: "   ", environmentId: "env_base" }),
		});
		const body = await response.json();

		expect(response.status).toBe(400);
		expect(body.error.message).toBe("agentId and prompt are required");
		expect(calls.startSession).toHaveLength(0);
	});

	test("POST /api/sessions requires an environment id", async () => {
		const response = await sessionsApp.request("/sessions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ agentId: "bailian-cli", prompt: "hello" }),
		});

		expect(response.status).toBe(400);
		expect(calls.startSession).toHaveLength(0);
	});

	test("POST /api/sessions creates a session with a trimmed prompt", async () => {
		const response = await sessionsApp.request("/sessions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				agentId: "bailian-cli",
				prompt: "  hello kitten  ",
				environmentId: "env_base",
				title: "Kitten",
				model: "glm-5.1",
			}),
		});
		const body = await response.json();

		expect(response.status).toBe(201);
		expect(calls.startSession).toEqual([
			[
				{
					agentId: "bailian-cli",
					prompt: "hello kitten",
					environmentId: "env_base",
					title: "Kitten",
					model: "glm-5.1",
				},
			],
		]);
		expect(body.session.session_id).toBe("created");
		expect(body.events[0].metadata.raw).toBeUndefined();
	});

	test("POST /api/sessions/:sessionId/messages validates message", async () => {
		const response = await sessionsApp.request("/sessions/session-1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ agentId: "agent-a", message: "  " }),
		});
		const body = await response.json();

		expect(response.status).toBe(400);
		expect(body.error.message).toBe("message is required");
		expect(calls.sendMessage).toHaveLength(0);
	});

	test("POST /api/sessions/:sessionId/messages sends a trimmed follow-up", async () => {
		const response = await sessionsApp.request("/sessions/session-1/messages", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ agentId: "agent-a", message: "  continue  " }),
		});
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(calls.sendMessage).toEqual([["session-1", "continue", "agent-a"]]);
		expect(body.session.title).toBe("follow-up");
		expect(body.events[0].metadata.raw).toBeUndefined();
	});

	test("DELETE /api/sessions/:sessionId removes the session", async () => {
		const response = await sessionsApp.request("/sessions/session-1?agentId=agent-a", { method: "DELETE" });
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(calls.deleteSession).toEqual([["session-1", "agent-a"]]);
		expect(body).toEqual({ session_id: "session-1", deleted: true });
	});

	test("GET /api/agents returns agent readiness with agentId", async () => {
		const response = await agentsApp.request("/agents?agentId=bailian-cli");
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(globalThis.__withAgentRuntimeCalls).toEqual([["bailian-cli"]]);
		expect(calls.listAgentsWithReadiness[0][1]).toEqual({ refresh: false });
		expect(body.agents[0].agent.id).toBe("bailian-cli");
		expect(body.agents[0].readiness.agentId).toBe("bailian-cli");
	});

	test("GET /api/cloud-agents returns raw cloud agents under the default Agents/ prefix", async () => {
		const response = await agentsApp.request("/cloud-agents");
		const body = await response.json();

		expect(response.status).toBe(200);
		// Resolved against the bootstrap agent runtime once (not a per-request agentId).
		expect(globalThis.__withAgentRuntimeCalls).toHaveLength(1);
		expect(calls.listCloudAgents[0][1]).toEqual({ prefix: "Agents/", limit: 100 });
		expect(body.agents[0].id).toBe("agt_cloud_1");
		expect(body.agents[0].name).toBe("Agents/researcher");
		expect(body.agents[0].metadata[PLAYBOOK_APP_METADATA_KEY]).toBe(getPlaybookAppId());
		expect(body.agents[0].metadata[PLAYBOOK_METADATA_KEY]).toBe("researcher");
	});

	test("GET /api/cloud-agents forwards a trimmed custom prefix", async () => {
		const response = await agentsApp.request("/cloud-agents?prefix=%20Agents%2Fx%20");

		expect(response.status).toBe(200);
		expect(calls.listCloudAgents[0][1]).toEqual({ prefix: "Agents/x", limit: 100 });
	});
});

function sampleCloudAgent(overrides: Record<string, unknown> = {}) {
	return {
		id: "agt_cloud_1",
		name: "Agents/researcher",
		description: "playbook-stamped cloud agent",
		model: "qwen-max",
		metadata: { [PLAYBOOK_APP_METADATA_KEY]: getPlaybookAppId(), [PLAYBOOK_METADATA_KEY]: "researcher" },
		version: 3,
		created_at: "2026-06-20T09:00:00.000Z",
		updated_at: "2026-06-20T09:01:00.000Z",
		...overrides,
	};
}

function sampleSession(overrides: Record<string, unknown> = {}) {
	return {
		session_id: "sesn_1",
		status: "completed",
		title: "hello",
		agent: { agent_id: "bailian-cli", name: "bailian-cli", version: 1 },
		created_at: "2026-06-20T09:00:00.000Z",
		updated_at: "2026-06-20T09:01:00.000Z",
		metadata: {},
		...overrides,
	};
}

// Shaped as a ProviderSessionEvent — the route runs it through the real sanitizer, which maps
// it up to the snake_case contract event (type := raw_type, content := text blocks, redaction
// + debug-raw surfaced under metadata).
function sampleProviderEvent() {
	return {
		type: "tool_result",
		raw_type: "tool_call_output",
		role: "tool",
		content: `generated ${signedUrl()}`,
		raw: {
			output: `raw ${signedUrl()}`,
			nested: {
				token: "super-secret-token",
			},
		},
	};
}

function signedUrl() {
	return "https://example.com/cat.png?OSSAccessKeyId=test-key&Signature=secret-signature&Expires=123456";
}
