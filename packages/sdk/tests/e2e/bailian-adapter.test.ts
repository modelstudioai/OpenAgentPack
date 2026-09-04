import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BailianAdapter } from "../../src/internal/providers/bailian/adapter.ts";
import { DeploymentCreateConflictError } from "../../src/internal/providers/deployment-conflict.ts";
import type {
	DeploymentContext,
	ResolvedAgentRefs,
	ResolvedDeploymentRefs,
} from "../../src/internal/providers/interface.ts";
import type { AgentDecl, DeploymentDecl, EnvironmentDecl, SkillDecl } from "../../src/internal/types/config.ts";
import type { SessionBindings } from "../../src/internal/types/session.ts";
import type { SkillFile } from "../../src/internal/types/skill-file.ts";

// ---------------------------------------------------------------------------
// Fetch mock infrastructure
// ---------------------------------------------------------------------------

interface CapturedCall {
	url: string;
	method: string;
	body?: unknown;
	isFormData?: boolean;
}

const BASE = "https://ws-test.cn-beijing.maas.aliyuncs.com/api/v1/agentstudio";

function mockFetch(responses: Array<{ status: number; body?: unknown }>) {
	let callIndex = 0;
	const calls: CapturedCall[] = [];
	const originalFetch = globalThis.fetch;

	globalThis.fetch = mock(async (input: string | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		const method = init?.method ?? "GET";

		const captured: CapturedCall = { url, method };
		if (init?.body instanceof FormData) {
			captured.isFormData = true;
		} else if (init?.body && typeof init.body === "string") {
			captured.body = JSON.parse(init.body);
		}
		calls.push(captured);

		const resp = responses[callIndex++];
		if (!resp) throw new Error(`Unexpected fetch call #${callIndex}: ${method} ${url}`);

		return new Response(resp.body !== undefined ? JSON.stringify(resp.body) : "", {
			status: resp.status,
			headers: { "Content-Type": "application/json" },
		});
	}) as unknown as typeof fetch;

	return {
		calls,
		restore: () => {
			globalThis.fetch = originalFetch;
		},
	};
}

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

function makeAdapter(baseUrl?: string): BailianAdapter {
	return new BailianAdapter("sk-test-key", "ws-test", baseUrl, "test-project");
}

const ENV_RESPONSE = {
	id: "env_OWNjZGNmZjRkMzk1NDVlYT",
	type: "environment",
	name: "dev-env",
	scope: "organization",
	created_at: "2026-06-16T12:45:34+08:00",
	updated_at: "2026-06-16T12:45:34+08:00",
};

const AGENT_RESPONSE = {
	id: "agent_01HKDPNVR8YZ7VBHKPK9CYNVTA",
	type: "agent",
	version: 1,
	name: "helper",
	model: { id: "qwen3.7-max" },
	system: "You are helpful.",
	created_at: "2026-05-28T16:23:11.456+08:00",
	updated_at: "2026-05-28T16:23:11.456+08:00",
};

const SESSION_RESPONSE = {
	id: "sesn_01HKDRP6CYX2YVQ9G7QGKJXVT",
	type: "session",
	status: "idle",
	agent: {
		id: "agent_01HKDPNVR8YZ7VBHKPK9CYNVTA",
		type: "agent",
		version: 1,
		name: "helper",
		model: { id: "qwen3.7-max" },
		system: "You are helpful.",
	},
	environment_id: "env_xxx",
	title: "Test session",
	created_at: "2026-05-28T08:23:11Z",
	updated_at: "2026-05-28T08:23:11Z",
};

const SKILL_RESPONSE = {
	id: "skill-NWVhN2MyM2MyZjA3",
	type: "skill",
	name: "code-review",
	status: "security_scanning",
	latest_version: "1.0",
	created_at: "2026-06-16T07:56:03Z",
	updated_at: "2026-06-16T07:56:03Z",
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BailianAdapter e2e", () => {
	let cleanup: (() => void) | undefined;

	afterEach(() => {
		cleanup?.();
		cleanup = undefined;
	});

	// ---- validate ----

	describe("validate", () => {
		test("calls GET /agents?limit=1", async () => {
			const { calls, restore } = mockFetch([{ status: 200, body: { data: [] } }]);
			cleanup = restore;

			await makeAdapter().validate();
			expect(calls).toHaveLength(1);
			expect(calls[0]!.url).toBe(`${BASE}/agents?limit=1`);
			expect(calls[0]!.method).toBe("GET");
		});

		test("throws on API error", async () => {
			const { restore } = mockFetch([
				{
					status: 401,
					body: {
						type: "error",
						error: { code: "unauthorized", message: "Invalid key" },
					},
				},
			]);
			cleanup = restore;

			await expect(makeAdapter().validate()).rejects.toThrow("401");
		});
	});

	// ---- findResource ----

	describe("findResource", () => {
		test("finds an environment by name", async () => {
			const { calls, restore } = mockFetch([
				{
					status: 200,
					body: {
						data: [ENV_RESPONSE, { ...ENV_RESPONSE, id: "env_other", name: "other" }],
					},
				},
			]);
			cleanup = restore;

			const result = await makeAdapter().findResource("environment", "dev-env");
			expect(calls[0]!.url).toBe(`${BASE}/environments?limit=100`);
			expect(result).not.toBeNull();
			expect(result!.id).toBe("env_OWNjZGNmZjRkMzk1NDVlYT");
		});

		test("returns null when not found", async () => {
			const { restore } = mockFetch([
				{
					status: 200,
					body: { data: [{ id: "env_1", name: "other", type: "environment" }] },
				},
			]);
			cleanup = restore;

			const result = await makeAdapter().findResource("environment", "nonexistent");
			expect(result).toBeNull();
		});

		test("returns null for unmapped resource types", async () => {
			const result = await makeAdapter().findResource("memory_store", "any");
			expect(result).toBeNull();
		});

		test("verifies by id via the detail endpoint when id is provided", async () => {
			const { calls, restore } = mockFetch([{ status: 200, body: ENV_RESPONSE }]);
			cleanup = restore;

			const result = await makeAdapter().findResource("environment", "dev-env", "env_OWNjZGNmZjRkMzk1NDVlYT");
			// Hits GET /{id} (no list, no ?limit) — avoids name-ambiguity.
			expect(calls[0]!.url).toBe(`${BASE}/environments/env_OWNjZGNmZjRkMzk1NDVlYT`);
			expect(result!.id).toBe("env_OWNjZGNmZjRkMzk1NDVlYT");
		});

		test("returns null when the id detail endpoint 404s", async () => {
			const { calls, restore } = mockFetch([{ status: 404, body: { error: "not found" } }]);
			cleanup = restore;

			const result = await makeAdapter().findResource("environment", "dev-env", "env_gone");
			expect(calls[0]!.url).toBe(`${BASE}/environments/env_gone`);
			expect(result).toBeNull();
		});
	});

	// ---- Environment CRUD ----

	describe("Environment CRUD", () => {
		const envDecl: EnvironmentDecl = {
			config: {
				type: "cloud",
				packages: { pip: ["numpy"], apt: ["curl"] },
			},
			metadata: { team: "infra" },
		};

		test("createEnvironment sends correct body and parses response", async () => {
			const { calls, restore } = mockFetch([{ status: 200, body: ENV_RESPONSE }]);
			cleanup = restore;

			const result = await makeAdapter().createEnvironment("dev-env", envDecl);

			expect(calls).toHaveLength(1);
			expect(calls[0]!.url).toBe(`${BASE}/environments`);
			expect(calls[0]!.method).toBe("POST");

			const body = calls[0]!.body as Record<string, unknown>;
			expect(body.name).toBe("dev-env");
			expect(body.scope).toBe("organization");
			expect((body.config as any).type).toBe("cloud");
			expect((body.config as any).networking).toEqual({ type: "unrestricted" });
			expect((body.config as any).packages).toEqual({
				pip: ["numpy"],
				apt: ["curl"],
			});
			expect((body.metadata as any)["agents.project"]).toBe("test-project");
			expect((body.metadata as any).team).toBe("infra");

			expect(result.id).toBe("env_OWNjZGNmZjRkMzk1NDVlYT");
			expect(result.type).toBe("environment");
		});

		test("updateEnvironment posts to /environments/{id}", async () => {
			const { calls, restore } = mockFetch([
				{
					status: 200,
					body: { ...ENV_RESPONSE, updated_at: "2026-06-16T12:52:31+08:00" },
				},
			]);
			cleanup = restore;

			const result = await makeAdapter().updateEnvironment("env_OWNjZGNmZjRkMzk1NDVlYT", "dev-env", envDecl);

			expect(calls[0]!.url).toBe(`${BASE}/environments/env_OWNjZGNmZjRkMzk1NDVlYT`);
			expect(calls[0]!.method).toBe("POST");
			expect(result.id).toBe("env_OWNjZGNmZjRkMzk1NDVlYT");
		});

		test("deleteEnvironment sends DELETE", async () => {
			const { calls, restore } = mockFetch([{ status: 200 }]);
			cleanup = restore;

			await makeAdapter().deleteEnvironment("env_OWNjZGNmZjRkMzk1NDVlYT");

			expect(calls[0]!.url).toBe(`${BASE}/environments/env_OWNjZGNmZjRkMzk1NDVlYT`);
			expect(calls[0]!.method).toBe("DELETE");
		});
	});

	// ---- Agent CRUD ----

	describe("Agent CRUD", () => {
		const agentDecl: AgentDecl = {
			model: "qwen3.7-max",
			instructions: "You are helpful.",
			description: "Helper agent",
			tools: {
				builtin: ["bash", "read"],
				mcp: [
					{
						type: "mcp_toolkit",
						mcp_server_name: "WebSearch",
						default_config: { enabled: false },
						configs: [{ name: "bailian_web_search", enabled: true }],
					},
				],
			},
			mcp_servers: [{ type: "official", name: "WebSearch" }],
		};
		const refs: ResolvedAgentRefs = {
			skill_ids: [{ type: "official", skill_id: "skill_abc123" }],
		};

		test("createAgent maps all fields and calls POST /agents", async () => {
			const { calls, restore } = mockFetch([
				{
					status: 200,
					body: {
						data: [
							{
								version: "1.0",
								status: "active",
								created_at: "2026-06-16T07:56:03Z",
							},
						],
					},
				},
				{ status: 200, body: AGENT_RESPONSE },
			]);
			cleanup = restore;

			const result = await makeAdapter().createAgent("helper", agentDecl, refs);

			expect(calls).toHaveLength(2);
			expect(calls[0]!.url).toBe(`${BASE}/skills/skill_abc123/versions`);
			expect(calls[0]!.method).toBe("GET");

			expect(calls[1]!.url).toBe(`${BASE}/agents`);
			expect(calls[1]!.method).toBe("POST");

			const body = calls[1]!.body as Record<string, unknown>;
			expect(body.name).toBe("helper");
			expect(body.model).toEqual({ id: "qwen3.7-max" });
			expect(body.system).toBe("You are helpful.");
			expect(body.description).toBe("Helper agent");
			expect(body.version).toBeUndefined();

			const tools = body.tools as any[];
			expect(tools[0].type).toBe("builtin_toolkit");
			expect(tools[0].default_config).toEqual({ enabled: false });
			expect(tools[0].configs).toEqual([
				{ name: "bash", enabled: true },
				{ name: "read", enabled: true },
			]);
			const mcpTool = tools.find((t: any) => t.type === "mcp_toolkit");
			expect(mcpTool.mcp_server_name).toBe("WebSearch");
			expect(mcpTool.default_config).toEqual({ enabled: false });
			expect(mcpTool.configs).toEqual([{ name: "bailian_web_search", enabled: true }]);

			expect(body.mcp_servers).toEqual([{ type: "official", name: "WebSearch" }]);
			expect(body.skills).toEqual([{ type: "official", skill_id: "skill_abc123", version: "1.0" }]);

			expect(result.id).toBe("agent_01HKDPNVR8YZ7VBHKPK9CYNVTA");
			expect(result.version).toBe(1);
		});

		test("createAgent uses explicit external skill version without fetching versions", async () => {
			const externalRefs: ResolvedAgentRefs = {
				skill_ids: [{ type: "official", skill_id: "pptx", version: "1.0" }],
			};
			const { calls, restore } = mockFetch([{ status: 200, body: AGENT_RESPONSE }]);
			cleanup = restore;

			await makeAdapter().createAgent("helper", agentDecl, externalRefs);

			expect(calls).toHaveLength(1);
			expect(calls[0]!.url).toBe(`${BASE}/agents`);
			expect((calls[0]!.body as any).skills).toEqual([{ type: "official", skill_id: "pptx", version: "1.0" }]);
		});

		test("updateAgent reads current version then posts with it", async () => {
			const { calls, restore } = mockFetch([
				{ status: 200, body: { ...AGENT_RESPONSE, version: 3 } },
				{
					status: 200,
					body: {
						data: [
							{
								version: "1.0",
								status: "active",
								created_at: "2026-06-16T07:56:03Z",
							},
						],
					},
				},
				{ status: 200, body: { ...AGENT_RESPONSE, version: 4 } },
			]);
			cleanup = restore;

			const result = await makeAdapter().updateAgent("agent_01HKDPNVR8YZ7VBHKPK9CYNVTA", "helper", agentDecl, refs);

			expect(calls).toHaveLength(3);
			expect(calls[0]!.method).toBe("GET");
			expect(calls[0]!.url).toBe(`${BASE}/agents/agent_01HKDPNVR8YZ7VBHKPK9CYNVTA`);

			expect(calls[1]!.method).toBe("GET");
			expect(calls[1]!.url).toBe(`${BASE}/skills/skill_abc123/versions`);

			expect(calls[2]!.method).toBe("POST");
			expect(calls[2]!.url).toBe(`${BASE}/agents/agent_01HKDPNVR8YZ7VBHKPK9CYNVTA`);
			expect((calls[2]!.body as any).version).toBe(3);

			expect(result.version).toBe(4);
		});

		test("deleteAgent archives via POST", async () => {
			const { calls, restore } = mockFetch([
				{
					status: 200,
					body: {
						...AGENT_RESPONSE,
						archived_at: "2026-05-28T19:00:00.000+08:00",
					},
				},
			]);
			cleanup = restore;

			await makeAdapter().deleteAgent("agent_01HKDPNVR8YZ7VBHKPK9CYNVTA");

			expect(calls[0]!.method).toBe("POST");
			expect(calls[0]!.url).toBe(`${BASE}/agents/agent_01HKDPNVR8YZ7VBHKPK9CYNVTA/archive`);
		});

		test("createAgent with per-provider model record", async () => {
			const decl: AgentDecl = {
				model: { claude: "claude-sonnet-4-20250514", bailian: "qwen3-plus" },
				instructions: "test",
			};
			const { calls, restore } = mockFetch([{ status: 200, body: AGENT_RESPONSE }]);
			cleanup = restore;

			await makeAdapter().createAgent("helper", decl, { skill_ids: [] });
			expect((calls[0]!.body as any).model).toEqual({ id: "qwen3-plus" });
		});

		test("createAgent without explicit tools enables all by default", async () => {
			const decl: AgentDecl = { model: "qwen3.7-max", instructions: "test" };
			const { calls, restore } = mockFetch([{ status: 200, body: AGENT_RESPONSE }]);
			cleanup = restore;

			await makeAdapter().createAgent("helper", decl, { skill_ids: [] });
			const tools = (calls[0]!.body as any).tools;
			expect(tools[0].type).toBe("builtin_toolkit");
			expect(tools[0].default_config).toEqual({ enabled: true });
			expect(tools[0].configs).toEqual([]);
		});
	});

	// ---- Skill CRUD ----

	describe("Skill CRUD", () => {
		const mockFiles: SkillFile[] = [
			{
				relativePath: "SKILL.md",
				content: Buffer.from("# Test Skill\nThis is a test skill."),
			},
		];

		const skillDecl: SkillDecl = { source: "skills/code-review" };

		test("createSkill uploads zip then creates skill", async () => {
			const { calls, restore } = mockFetch([
				{ status: 200, body: { id: "file_uploaded123", type: "file" } },
				{ status: 200, body: { id: "file_uploaded123", status: "available" } },
				{ status: 200, body: { id: "file_uploaded123", status: "available" } },
				{ status: 200, body: SKILL_RESPONSE },
				{
					status: 200,
					body: {
						skill_id: "skill-NWVhN2MyM2MyZjA3",
						version: "1.0",
						status: "active",
					},
				},
			]);
			cleanup = restore;

			const result = await makeAdapter().createSkill("code-review", skillDecl, mockFiles);

			expect(calls).toHaveLength(5);

			// Call 1: file upload
			expect(calls[0]!.url).toBe(`${BASE}/files`);
			expect(calls[0]!.method).toBe("POST");
			expect(calls[0]!.isFormData).toBe(true);

			// Call 2: waitForFileReady (inside uploadSkillZip)
			expect(calls[1]!.url).toBe(`${BASE}/files/file_uploaded123`);
			expect(calls[1]!.method).toBe("GET");

			// Call 3: waitForFileAvailable (after upload)
			expect(calls[2]!.url).toBe(`${BASE}/files/file_uploaded123`);
			expect(calls[2]!.method).toBe("GET");

			// Call 4: create skill
			expect(calls[3]!.url).toBe(`${BASE}/skills`);
			expect(calls[3]!.method).toBe("POST");
			expect(calls[3]!.body).toEqual({ file_id: "file_uploaded123" });

			// Call 5: poll version status
			expect(calls[4]!.url).toBe(`${BASE}/skills/skill-NWVhN2MyM2MyZjA3/versions/1.0`);
			expect(calls[4]!.method).toBe("GET");

			expect(result.id).toBe("skill-NWVhN2MyM2MyZjA3");
			expect(result.type).toBe("skill");
		});

		test("updateSkill uploads zip then creates new version", async () => {
			const versionResponse = {
				skill_id: "skill-NWVhN2MyM2MyZjA3",
				type: "skill_version",
				version: "2.0",
				status: "security_scanning",
			};

			const { calls, restore } = mockFetch([
				{ status: 200, body: { id: "file_new456", type: "file" } },
				{ status: 200, body: { id: "file_new456", status: "available" } },
				{ status: 200, body: { id: "file_new456", status: "available" } },
				{ status: 200, body: versionResponse },
				{
					status: 200,
					body: {
						skill_id: "skill-NWVhN2MyM2MyZjA3",
						version: "2.0",
						status: "active",
					},
				},
			]);
			cleanup = restore;

			const result = await makeAdapter().updateSkill("skill-NWVhN2MyM2MyZjA3", "code-review", skillDecl, mockFiles);

			expect(calls[1]!.url).toBe(`${BASE}/files/file_new456`);
			expect(calls[1]!.method).toBe("GET");

			expect(calls[2]!.url).toBe(`${BASE}/files/file_new456`);
			expect(calls[2]!.method).toBe("GET");

			expect(calls[3]!.url).toBe(`${BASE}/skills/skill-NWVhN2MyM2MyZjA3/versions`);
			expect(calls[3]!.body).toEqual({ file_id: "file_new456" });

			expect(calls[4]!.url).toBe(`${BASE}/skills/skill-NWVhN2MyM2MyZjA3/versions/2.0`);
			expect(calls[4]!.method).toBe("GET");

			expect(result.id).toBe("skill-NWVhN2MyM2MyZjA3");
			expect(result.type).toBe("skill");
		});

		test("deleteSkill calls DELETE /skills/{id}", async () => {
			const { calls, restore } = mockFetch([
				{
					status: 200,
					body: { id: "skill-NWVhN2MyM2MyZjA3", type: "skill_deleted" },
				},
			]);
			cleanup = restore;

			await makeAdapter().deleteSkill("skill-NWVhN2MyM2MyZjA3");

			expect(calls[0]!.url).toBe(`${BASE}/skills/skill-NWVhN2MyM2MyZjA3`);
			expect(calls[0]!.method).toBe("DELETE");
		});

		test("createSkill with single-file source wraps as SKILL.md", async () => {
			const singleFileDecl: SkillDecl = {
				source: "skills/code-review/SKILL.md",
			};
			const { calls, restore } = mockFetch([
				{ status: 200, body: { id: "file_single", type: "file" } },
				{ status: 200, body: { id: "file_single", status: "available" } },
				{ status: 200, body: { id: "file_single", status: "available" } },
				{ status: 200, body: SKILL_RESPONSE },
				{
					status: 200,
					body: {
						skill_id: "skill-NWVhN2MyM2MyZjA3",
						version: "1.0",
						status: "active",
					},
				},
			]);
			cleanup = restore;

			await makeAdapter().createSkill("single-file-skill", singleFileDecl, mockFiles);

			expect(calls).toHaveLength(5);
			expect(calls[0]!.isFormData).toBe(true);
		});

		// The OpenAPI skill status enum is security_scanning/active/unsafe/deleted (internal
		// 0/1/2/100), verified against the live provider API. `unsafe` is the scan-failure terminal and must
		// surface as the neutral `rejected` — not `checking` — so the UI shows 已拒绝 instead of a stuck 扫描中.
		test("listSkills maps OpenAPI status enum to neutral status", async () => {
			const { restore } = mockFetch([
				{
					status: 200,
					body: {
						data: [
							{ id: "s_scan", name: "a", source: "customer", status: "security_scanning" },
							{ id: "s_active", name: "b", source: "customer", status: "active" },
							{ id: "s_unsafe", name: "c", source: "customer", status: "unsafe" },
							{ id: "s_deleted", name: "d", source: "official", status: "deleted" },
						],
					},
				},
			]);
			cleanup = restore;

			const skills = await makeAdapter().listSkills();

			expect(skills.map((s) => [s.id, s.status])).toEqual([
				["s_scan", "checking"],
				["s_active", "active"],
				["s_unsafe", "rejected"],
				["s_deleted", "deleted"],
			]);
		});
	});

	// ---- Session CRUD ----

	describe("Session CRUD", () => {
		test("createSession sends correct body", async () => {
			const { calls, restore } = mockFetch([{ status: 200, body: SESSION_RESPONSE }]);
			cleanup = restore;

			const bindings: SessionBindings = {
				agent_id: "agent_01HKDPNVR8YZ7VBHKPK9CYNVTA",
				environment_id: "env_xxx",
				vault_ids: [],
				memory_store_ids: [],
				title: "Test session",
				metadata: { ticket: "1234" },
			};

			const result = await makeAdapter().createSession(bindings);

			expect(calls[0]!.url).toBe(`${BASE}/sessions`);
			expect(calls[0]!.method).toBe("POST");

			const body = calls[0]!.body as Record<string, unknown>;
			expect(body.agent).toBe("agent_01HKDPNVR8YZ7VBHKPK9CYNVTA");
			expect(body.environment_id).toBe("env_xxx");
			expect(body.title).toBe("Test session");
			expect(body.metadata).toEqual({ ticket: "1234" });

			expect(result.id).toBe("sesn_01HKDRP6CYX2YVQ9G7QGKJXVT");
			expect(result.agent_id).toBe("agent_01HKDPNVR8YZ7VBHKPK9CYNVTA");
			expect(result.environment_id).toBe("env_xxx");
			expect(result.status).toBe("idle");
			expect(result.vault_ids).toEqual([]);
			expect(result.memory_store_ids).toEqual([]);
		});

		test("listSessions passes query params", async () => {
			const { calls, restore } = mockFetch([
				{
					status: 200,
					body: {
						data: [SESSION_RESPONSE],
						next_page: "page_jNXZkRgIxEgGz52bpN3clNHCSEAC",
					},
				},
			]);
			cleanup = restore;

			const result = await makeAdapter().listSessions({
				agent_id: "agent_xxx",
				limit: 10,
			});

			expect(calls[0]!.url).toBe(`${BASE}/sessions?agent_id=agent_xxx&limit=10`);
			expect(result.sessions).toHaveLength(1);
			expect(result.has_more).toBe(true);
		});

		test("listSessions returns has_more=false on last page", async () => {
			const { calls, restore } = mockFetch([
				{
					status: 200,
					body: { data: [SESSION_RESPONSE] },
				},
			]);
			cleanup = restore;

			const result = await makeAdapter().listSessions();
			expect(calls[0]!.url).toBe(`${BASE}/sessions`);
			expect(result.has_more).toBe(false);
		});

		test("getSession returns parsed info", async () => {
			const { calls, restore } = mockFetch([{ status: 200, body: SESSION_RESPONSE }]);
			cleanup = restore;

			const result = await makeAdapter().getSession("sesn_01HKDRP6CYX2YVQ9G7QGKJXVT");

			expect(calls[0]!.url).toBe(`${BASE}/sessions/sesn_01HKDRP6CYX2YVQ9G7QGKJXVT`);
			expect(result.id).toBe("sesn_01HKDRP6CYX2YVQ9G7QGKJXVT");
			expect(result.status).toBe("idle");
			expect(result.title).toBe("Test session");
		});

		test("deleteSession calls DELETE", async () => {
			const { calls, restore } = mockFetch([{ status: 200 }]);
			cleanup = restore;

			await makeAdapter().deleteSession("sesn_01HKDRP6CYX2YVQ9G7QGKJXVT");

			expect(calls[0]!.url).toBe(`${BASE}/sessions/sesn_01HKDRP6CYX2YVQ9G7QGKJXVT`);
			expect(calls[0]!.method).toBe("DELETE");
		});

		// REST binds a vault via the top-level `vault_ids` array (the shape the backend injection
		// reads); only files travel in `resources`. So a vault-only create sends no `resources`.
		test("createSession binds vaults as top-level vault_ids, not resources", async () => {
			const { calls, restore } = mockFetch([{ status: 200, body: SESSION_RESPONSE }]);
			cleanup = restore;

			await makeAdapter().createSession({
				agent_id: "agent_01HKDPNVR8YZ7VBHKPK9CYNVTA",
				environment_id: "env_xxx",
				vault_ids: ["vlt_a", "vlt_b"],
				memory_store_ids: [],
			});

			const body = calls[0]!.body as Record<string, unknown>;
			expect(body.vault_ids).toEqual(["vlt_a", "vlt_b"]);
			expect(body.resources).toBeUndefined();
		});

		// Backend SessionDTO echoes bound vaults as a top-level `vault_ids` (undefined
		// until the feature ships → []). Don't reconstruct from `resources`.
		test("getSession reads top-level vault_ids when present", async () => {
			const { restore } = mockFetch([
				{
					status: 200,
					body: { ...SESSION_RESPONSE, vault_ids: ["vlt_a", "vlt_b"] },
				},
			]);
			cleanup = restore;

			const result = await makeAdapter().getSession("sesn_01HKDRP6CYX2YVQ9G7QGKJXVT");
			expect(result.vault_ids).toEqual(["vlt_a", "vlt_b"]);
		});

		test("getSession falls back to [] when vault_ids absent", async () => {
			const { restore } = mockFetch([{ status: 200, body: SESSION_RESPONSE }]);
			cleanup = restore;

			const result = await makeAdapter().getSession("sesn_01HKDRP6CYX2YVQ9G7QGKJXVT");
			expect(result.vault_ids).toEqual([]);
		});
	});

	// ---- Deployment (native) ----

	describe("Deployment (native)", () => {
		const deploymentDecl: DeploymentDecl = {
			agent: "helper",
			initial_events: [{ type: "user.message", content: "Please analyze the data." }],
			description: "Analysis task",
			schedule: { expression: "0 9 * * *", timezone: "UTC" },
		};
		const deployRefs: ResolvedDeploymentRefs = {
			agent_id: "agent_xxx",
			environment_id: "env_yyy",
			vault_ids: ["vlt_1"],
			memory_store_ids: {},
		};
		const DEPLOYMENT_RESPONSE = {
			id: "depl_new",
			type: "deployment",
			name: "deploy-1",
			status: "active",
		};

		test("createDeployment posts the deployment body", async () => {
			const { calls, restore } = mockFetch([{ status: 200, body: DEPLOYMENT_RESPONSE }]);
			cleanup = restore;

			const result = await makeAdapter().createDeployment("deploy-1", deploymentDecl, deployRefs, "/fake/path");

			expect(calls).toHaveLength(1);
			expect(calls[0]!.url).toBe(`${BASE}/deployments`);
			expect(calls[0]!.method).toBe("POST");
			const body = calls[0]!.body as Record<string, unknown>;
			expect(body.name).toBe("deploy-1");
			expect(body.agent).toEqual({ id: "agent_xxx" });
			expect(body.environment_id).toBe("env_yyy");
			expect(body.description).toBe("Analysis task");
			expect(body.vault_ids).toEqual(["vlt_1"]);
			expect(body.schedule).toEqual({ type: "cron", expression: "0 9 * * *", timezone: "UTC" });
			expect(body.initial_events).toEqual([
				{ role: "user", type: "message", content: [{ type: "text", text: "Please analyze the data." }] },
			]);
			// Project name is stamped onto metadata for resource ownership tracking.
			expect((body.metadata as Record<string, unknown>)["agents.project"]).toBe("test-project");
			expect(result.id).toBe("depl_new");
			expect(result.type).toBe("deployment");
		});

		test("createDeployment pins agent version when resolved", async () => {
			const { calls, restore } = mockFetch([{ status: 200, body: DEPLOYMENT_RESPONSE }]);
			cleanup = restore;

			await makeAdapter().createDeployment(
				"deploy-1",
				deploymentDecl,
				{ ...deployRefs, agent_version: 12 },
				"/fake/path",
			);
			expect((calls[0]!.body as Record<string, unknown>).agent).toEqual({ id: "agent_xxx", version: 12 });
		});

		test("createDeployment uploads file resources and waits for availability first", async () => {
			const dir = mkdtempSync(join(tmpdir(), "bailian-depl-"));
			writeFileSync(join(dir, "report.md"), "# template");
			const declWithFile: DeploymentDecl = {
				agent: "helper",
				initial_events: [{ type: "user.message", content: "analyze" }],
				resources: [{ type: "file", source: "./report.md", mount_path: "/mnt/report.md" }],
			};
			const { calls, restore } = mockFetch([
				{ status: 200, body: { id: "file_up", status: "checking" } },
				{ status: 200, body: { id: "file_up", status: "available" } },
				{ status: 200, body: { ...DEPLOYMENT_RESPONSE, id: "depl_files" } },
			]);
			cleanup = restore;

			const result = await makeAdapter().createDeployment(
				"deploy-1",
				declWithFile,
				deployRefs,
				join(dir, "agents.yaml"),
			);
			expect(result.id).toBe("depl_files");

			expect(calls[0]!.url).toBe(`${BASE}/files`);
			expect(calls[0]!.method).toBe("POST");
			expect(calls[1]!.url).toBe(`${BASE}/files/file_up`);
			expect(calls[2]!.url).toBe(`${BASE}/deployments`);
			const body = calls[2]!.body as Record<string, unknown>;
			expect((body.resources as any[])[0]).toEqual({
				type: "file",
				file_id: "file_up",
				mount_path: "/mnt/report.md",
			});
		});

		test("createDeployment preserves uploaded files when the deployment conflicts", async () => {
			const dir = mkdtempSync(join(tmpdir(), "bailian-depl-conflict-"));
			writeFileSync(join(dir, "report.md"), "# template");
			const declWithFile: DeploymentDecl = {
				agent: "helper",
				initial_events: [{ type: "user.message", content: "analyze" }],
				resources: [{ type: "file", source: "./report.md", mount_path: "/mnt/report.md" }],
			};
			const { calls, restore } = mockFetch([
				{ status: 200, body: { id: "file_up", status: "checking" } },
				{ status: 200, body: { id: "file_up", status: "available" } },
				{ status: 409, body: { message: "deployment already exists" } },
			]);
			cleanup = restore;

			const error = await makeAdapter()
				.createDeployment("deploy-1", declWithFile, deployRefs, join(dir, "agents.yaml"))
				.catch((caught) => caught);

			expect(error).toBeInstanceOf(DeploymentCreateConflictError);
			expect((error as DeploymentCreateConflictError).preparedFiles.get("./report.md")).toBe("file_up");
			expect(calls.filter((call) => call.url === `${BASE}/files`)).toHaveLength(1);
		});

		test("updateDeployment reuses files preserved by a conflicting create", async () => {
			const declWithFile: DeploymentDecl = {
				agent: "helper",
				initial_events: [{ type: "user.message", content: "analyze" }],
				resources: [{ type: "file", source: "./report.md", mount_path: "/mnt/report.md" }],
			};
			const { calls, restore } = mockFetch([
				{ status: 200, body: { id: "depl_xxx", metadata: {} } },
				{ status: 200, body: { ...DEPLOYMENT_RESPONSE, id: "depl_xxx" } },
			]);
			cleanup = restore;

			await makeAdapter().updateDeployment(
				"depl_xxx",
				"deploy-1",
				declWithFile,
				deployRefs,
				"/unused/agents.yaml",
				new Map([["./report.md", "file_up"]]),
			);

			expect(calls).toHaveLength(2);
			expect(calls.some((call) => call.url === `${BASE}/files`)).toBe(false);
			expect((calls[1]!.body as Record<string, unknown>).resources).toEqual([
				{ type: "file", file_id: "file_up", mount_path: "/mnt/report.md" },
			]);
		});

		test("updateDeployment reads current then posts to the id", async () => {
			const { calls, restore } = mockFetch([
				{ status: 200, body: { id: "depl_xxx", schedule: { type: "cron", expression: "0 9 * * *" } } },
				{ status: 200, body: { ...DEPLOYMENT_RESPONSE, id: "depl_xxx" } },
			]);
			cleanup = restore;

			const result = await makeAdapter().updateDeployment(
				"depl_xxx",
				"deploy-1",
				deploymentDecl,
				deployRefs,
				"/fake/path",
			);

			expect(calls[0]!.url).toBe(`${BASE}/deployments/depl_xxx`);
			expect(calls[0]!.method).toBe("GET");
			expect(calls[1]!.url).toBe(`${BASE}/deployments/depl_xxx`);
			expect(calls[1]!.method).toBe("POST");
			expect(result.id).toBe("depl_xxx");
		});

		test("updateDeployment switches a scheduled deployment to manual", async () => {
			const { calls, restore } = mockFetch([
				{ status: 200, body: { id: "depl_xxx", schedule: { type: "cron", expression: "0 9 * * *" } } },
				{ status: 200, body: { ...DEPLOYMENT_RESPONSE, id: "depl_xxx", schedule: null } },
			]);
			cleanup = restore;

			const manualDecl: DeploymentDecl = { agent: "helper", initial_events: [] };
			const result = await makeAdapter().updateDeployment("depl_xxx", "deploy-1", manualDecl, deployRefs, "/fake/path");

			expect(calls).toHaveLength(2);
			expect(calls[1]!.url).toBe(`${BASE}/deployments/depl_xxx`);
			expect(calls[1]!.method).toBe("POST");
			expect((calls[1]!.body as Record<string, unknown>).schedule).toBeNull();
			expect(result.id).toBe("depl_xxx");
		});

		test("updateDeployment materializes a never-applied (null-id) deployment via create", async () => {
			const { calls, restore } = mockFetch([{ status: 200, body: DEPLOYMENT_RESPONSE }]);
			cleanup = restore;

			const result = await makeAdapter().updateDeployment("", "deploy-1", deploymentDecl, deployRefs, "/fake/path");

			expect(calls).toHaveLength(1);
			expect(calls[0]!.url).toBe(`${BASE}/deployments`);
			expect(calls[0]!.method).toBe("POST");
			expect(result.id).toBe("depl_new");
		});

		test("deleteDeployment archives the deployment", async () => {
			const { calls, restore } = mockFetch([
				{ status: 200, body: { id: "depl_xxx", archived_at: "2026-07-28T03:00:00Z" } },
			]);
			cleanup = restore;

			await makeAdapter().deleteDeployment("depl_xxx");
			expect(calls).toHaveLength(1);
			expect(calls[0]!.url).toBe(`${BASE}/deployments/depl_xxx/archive`);
			expect(calls[0]!.method).toBe("POST");
		});

		test("runDeployment triggers a server-side run", async () => {
			const { calls, restore } = mockFetch([
				{ status: 200, body: { id: "drun_1", type: "deployment_run", session_id: null, status: "running" } },
			]);
			cleanup = restore;

			const result = await makeAdapter().runDeployment({
				id: "depl_xxx",
				name: "analysis",
				decl: deploymentDecl,
				refs: deployRefs,
				basePath: "/fake/project.yaml",
			});

			expect(calls).toHaveLength(1);
			expect(calls[0]!.url).toBe(`${BASE}/deployments/depl_xxx/run`);
			expect(calls[0]!.method).toBe("POST");
			expect(result.run_id).toBe("drun_1");
			expect(result.session_id).toBeNull();
		});

		test("runDeployment rejects a deployment with no remote id", async () => {
			expect(
				makeAdapter().runDeployment({
					id: null,
					name: "analysis",
					decl: deploymentDecl,
					refs: deployRefs,
					basePath: "/fake/project.yaml",
				}),
			).rejects.toThrow(/no remote id/);
		});

		test("getDeployment reads the remote deployment", async () => {
			const { calls, restore } = mockFetch([
				{
					status: 200,
					body: {
						id: "depl_xxx",
						status: "active",
						schedule: { type: "cron", expression: "0 9 * * *", timezone: "UTC" },
					},
				},
			]);
			cleanup = restore;

			const result = await makeAdapter().getDeployment({
				id: "depl_xxx",
				name: "analysis",
				decl: deploymentDecl,
				refs: deployRefs,
				basePath: "/fake/project.yaml",
			});

			expect(calls[0]!.url).toBe(`${BASE}/deployments/depl_xxx`);
			expect(calls[0]!.method).toBe("GET");
			expect(result.id).toBe("depl_xxx");
			expect(result.status).toBe("active");
			expect(result.schedule).toEqual({ expression: "0 9 * * *", timezone: "UTC" });
		});

		test("listDeployments forwards filters and derives has_more from next_page", async () => {
			const { calls, restore } = mockFetch([
				{ status: 200, body: { data: [{ id: "depl_1", status: "active" }], next_page: "cursor_2" } },
			]);
			cleanup = restore;

			const result = await makeAdapter().listDeployments({ agent_id: "agent_xxx", status: "active", limit: 50 });

			const url = new URL(calls[0]!.url);
			expect(url.pathname).toBe("/api/v1/agentstudio/deployments");
			expect(url.searchParams.get("agent_id")).toBe("agent_xxx");
			expect(url.searchParams.get("status")).toBe("active");
			expect(url.searchParams.get("limit")).toBe("50");
			expect(result.deployments).toHaveLength(1);
			expect(result.has_more).toBe(true);
			expect(result.next_page).toBe("cursor_2");
		});

		test("pauseDeployment and unpauseDeployment hit their endpoints", async () => {
			const { calls, restore } = mockFetch([
				{ status: 200, body: { id: "depl_xxx", status: "paused" } },
				{ status: 200, body: { id: "depl_xxx", status: "active" } },
			]);
			cleanup = restore;

			const ctx: DeploymentContext = {
				id: "depl_xxx",
				name: "analysis",
				decl: deploymentDecl,
				refs: deployRefs,
				basePath: "/fake/project.yaml",
			};
			const paused = await makeAdapter().pauseDeployment(ctx);
			const active = await makeAdapter().unpauseDeployment(ctx);

			expect(calls[0]!.url).toBe(`${BASE}/deployments/depl_xxx/pause`);
			expect(calls[1]!.url).toBe(`${BASE}/deployments/depl_xxx/unpause`);
			expect(paused.status).toBe("paused");
			expect(active.status).toBe("active");
		});
	});

	// ---- Vault CRUD ----

	describe("Vault CRUD", () => {
		const VAULT_RESPONSE = {
			id: "vlt_011CZkZDLs7fYzm1hXNPeRjv",
			type: "vault",
			display_name: "Secrets",
			created_at: "2026-03-15T10:00:00Z",
			updated_at: "2026-03-15T10:00:00Z",
		};

		test("createVault posts vault then each supported credential", async () => {
			const { calls, restore } = mockFetch([
				{ status: 200, body: VAULT_RESPONSE },
				{ status: 200, body: { id: "cred_1", type: "credential" } },
			]);
			cleanup = restore;

			const result = await makeAdapter().createVault("secrets", {
				display_name: "Secrets",
				metadata: { env: "prod" },
				credentials: [
					{
						name: "token",
						type: "environment_variable",
						secret_name: "MCP_TOKEN",
						secret_value: "tok-123",
						networking: { allowed_hosts: ["api.example.com", "*.example.org"] },
					},
				],
			});

			expect(calls).toHaveLength(2);

			// 1) create vault
			expect(calls[0]!.url).toBe(`${BASE}/vaults`);
			expect(calls[0]!.method).toBe("POST");
			const vaultBody = calls[0]!.body as Record<string, unknown>;
			expect(vaultBody.display_name).toBe("Secrets");
			expect((vaultBody.metadata as any)["agents.project"]).toBe("test-project");
			expect((vaultBody.metadata as any)["agents.resource"]).toBe("secrets");
			expect((vaultBody.metadata as any).env).toBe("prod");

			// 2) create credential under the returned vault id
			expect(calls[1]!.url).toBe(`${BASE}/vaults/vlt_011CZkZDLs7fYzm1hXNPeRjv/credentials`);
			expect(calls[1]!.method).toBe("POST");
			const credBody = calls[1]!.body as Record<string, unknown>;
			expect(credBody.display_name).toBe("token");
			expect(credBody.auth).toEqual({
				type: "environment_variable",
				secret_name: "MCP_TOKEN",
				secret_value: "tok-123",
				networking: { allowed_hosts: ["api.example.com", "*.example.org"] },
				injection_location: { header: true, body: false },
			});

			expect(result.id).toBe("vlt_011CZkZDLs7fYzm1hXNPeRjv");
			expect(result.type).toBe("vault");
		});

		test("createVault without credentials posts only the vault", async () => {
			const { calls, restore } = mockFetch([{ status: 200, body: VAULT_RESPONSE }]);
			cleanup = restore;

			await makeAdapter().createVault("secrets", {
				display_name: "Secrets",
				credentials: [],
			});

			expect(calls).toHaveLength(1);
			expect(calls[0]!.url).toBe(`${BASE}/vaults`);
		});

		test("createVault rejects unsupported credentials before creating the parent vault", async () => {
			const { calls, restore } = mockFetch([]);
			cleanup = restore;

			await expect(
				makeAdapter().createVault("secrets", {
					display_name: "Secrets",
					credentials: [
						{
							name: "token",
							type: "static_bearer",
							mcp_server_url: "https://example.com/mcp",
							access_token: "tok-123",
						},
					],
				}),
			).rejects.toThrow(/Bailian only supports credential type 'environment_variable'/);
			expect(calls).toHaveLength(0);
		});

		test("deleteVault sends DELETE", async () => {
			const { calls, restore } = mockFetch([{ status: 200 }]);
			cleanup = restore;

			await makeAdapter().deleteVault("vlt_011CZkZDLs7fYzm1hXNPeRjv");

			expect(calls[0]!.url).toBe(`${BASE}/vaults/vlt_011CZkZDLs7fYzm1hXNPeRjv`);
			expect(calls[0]!.method).toBe("DELETE");
		});

		test("listVaults GETs and maps the data array", async () => {
			const { calls, restore } = mockFetch([
				{
					status: 200,
					body: { data: [VAULT_RESPONSE, { ...VAULT_RESPONSE, id: "vlt_2" }] },
				},
			]);
			cleanup = restore;

			const result = await makeAdapter().listVaults();

			expect(calls[0]!.url).toBe(`${BASE}/vaults?limit=100`);
			expect(calls[0]!.method).toBe("GET");
			expect(result.map((r) => r.id)).toEqual(["vlt_011CZkZDLs7fYzm1hXNPeRjv", "vlt_2"]);
		});

		test("listVaults paginates across every page", async () => {
			const { calls, restore } = mockFetch([
				{ status: 200, body: { data: [VAULT_RESPONSE], next_page: "V2" } },
				{
					status: 200,
					body: { data: [{ ...VAULT_RESPONSE, id: "vlt_2" }], next_page: null },
				},
			]);
			cleanup = restore;

			const result = await makeAdapter().listVaults();

			expect(calls.map((c) => c.url)).toEqual([`${BASE}/vaults?limit=100`, `${BASE}/vaults?limit=100&page=V2`]);
			expect(result.map((r) => r.id)).toEqual(["vlt_011CZkZDLs7fYzm1hXNPeRjv", "vlt_2"]);
		});

		test("getVault GETs /vaults/{id}", async () => {
			const { calls, restore } = mockFetch([{ status: 200, body: VAULT_RESPONSE }]);
			cleanup = restore;

			const result = await makeAdapter().getVault("vlt_011CZkZDLs7fYzm1hXNPeRjv");

			expect(calls[0]!.url).toBe(`${BASE}/vaults/vlt_011CZkZDLs7fYzm1hXNPeRjv`);
			expect(calls[0]!.method).toBe("GET");
			expect(result.display_name).toBe("Secrets");
		});

		test("updateVault POSTs patch to /vaults/{id}", async () => {
			const { calls, restore } = mockFetch([{ status: 200, body: { ...VAULT_RESPONSE, display_name: "New" } }]);
			cleanup = restore;

			const result = await makeAdapter().updateVault("vlt_011CZkZDLs7fYzm1hXNPeRjv", { display_name: "New" });

			expect(calls[0]!.url).toBe(`${BASE}/vaults/vlt_011CZkZDLs7fYzm1hXNPeRjv`);
			expect(calls[0]!.method).toBe("POST");
			expect((calls[0]!.body as any).display_name).toBe("New");
			expect(result.id).toBe("vlt_011CZkZDLs7fYzm1hXNPeRjv");
		});

		test("archiveVault POSTs /vaults/{id}/archive", async () => {
			const { calls, restore } = mockFetch([{ status: 200, body: VAULT_RESPONSE }]);
			cleanup = restore;

			await makeAdapter().archiveVault("vlt_011CZkZDLs7fYzm1hXNPeRjv");

			expect(calls[0]!.url).toBe(`${BASE}/vaults/vlt_011CZkZDLs7fYzm1hXNPeRjv/archive`);
			expect(calls[0]!.method).toBe("POST");
		});
	});

	// ---- Credential CRUD ----

	describe("Credential CRUD", () => {
		const VAULT_ID = "vlt_011CZkZDLs7fYzm1hXNPeRjv";
		const CRED_RESPONSE = {
			id: "vcrd_1",
			type: "credential",
			display_name: "token",
		};
		const staticCred = {
			name: "token",
			type: "static_bearer" as const,
			metadata: { owner: "cli" },
			mcp_server_url: "https://example.com/mcp",
			access_token: "tok-123",
		};

		test("createCredential rejects unsupported static_bearer before sending a request", async () => {
			const { calls, restore } = mockFetch([]);
			cleanup = restore;

			await expect(makeAdapter().createCredential(VAULT_ID, staticCred)).rejects.toThrow(
				/Bailian only supports credential type 'environment_variable'/,
			);
			expect(calls).toHaveLength(0);
		});

		test("createCredential maps environment_variable auth body", async () => {
			const { calls, restore } = mockFetch([{ status: 200, body: CRED_RESPONSE }]);
			cleanup = restore;

			await makeAdapter().createCredential(VAULT_ID, {
				name: "mcp-token",
				type: "environment_variable",
				secret_name: "MCP_TOKEN",
				secret_value: "tok-123",
			});

			expect(calls[0]!.url).toBe(`${BASE}/vaults/${VAULT_ID}/credentials`);
			expect(calls[0]!.method).toBe("POST");
			expect(calls[0]!.body).toEqual({
				auth: {
					type: "environment_variable",
					secret_name: "MCP_TOKEN",
					secret_value: "tok-123",
					networking: { allowed_hosts: ["*"] },
					injection_location: { header: true, body: false },
				},
				display_name: "mcp-token",
			});
		});

		test("listCredentials GETs and maps the data array", async () => {
			const { calls, restore } = mockFetch([
				{
					status: 200,
					body: { data: [CRED_RESPONSE, { ...CRED_RESPONSE, id: "vcrd_2" }] },
				},
			]);
			cleanup = restore;

			const result = await makeAdapter().listCredentials(VAULT_ID);

			expect(calls[0]!.url).toBe(`${BASE}/vaults/${VAULT_ID}/credentials?limit=100`);
			expect(calls[0]!.method).toBe("GET");
			expect(result.map((r) => r.id)).toEqual(["vcrd_1", "vcrd_2"]);
		});

		test("listCredentials preserves networking and injection policy without exposing the secret", async () => {
			const { restore } = mockFetch([
				{
					status: 200,
					body: {
						data: [
							{
								...CRED_RESPONSE,
								auth: {
									type: "environment_variable",
									secret_name: "API_TOKEN",
									secret_value: "never-expose-this",
									networking: { allowed_hosts: ["api.example.com", "*.example.org"] },
									injection_location: { header: true, body: false },
								},
							},
						],
					},
				},
			]);
			cleanup = restore;
			const result = await makeAdapter().listCredentials(VAULT_ID);
			expect(result[0]).toMatchObject({
				networking: { allowed_hosts: ["api.example.com", "*.example.org"] },
				injection_location: { header: true, body: false },
			});
			expect(JSON.stringify(result)).not.toContain("never-expose-this");
		});

		test("listCredentials paginates across every page", async () => {
			const { calls, restore } = mockFetch([
				{ status: 200, body: { data: [CRED_RESPONSE], next_page: "C2" } },
				{
					status: 200,
					body: { data: [{ ...CRED_RESPONSE, id: "vcrd_2" }], next_page: null },
				},
			]);
			cleanup = restore;

			const result = await makeAdapter().listCredentials(VAULT_ID);

			expect(calls.map((c) => c.url)).toEqual([
				`${BASE}/vaults/${VAULT_ID}/credentials?limit=100`,
				`${BASE}/vaults/${VAULT_ID}/credentials?limit=100&page=C2`,
			]);
			expect(result.map((r) => r.id)).toEqual(["vcrd_1", "vcrd_2"]);
		});

		test("getCredential GETs /vaults/{id}/credentials/{cid}", async () => {
			const { calls, restore } = mockFetch([{ status: 200, body: CRED_RESPONSE }]);
			cleanup = restore;

			const result = await makeAdapter().getCredential(VAULT_ID, "vcrd_1");

			expect(calls[0]!.url).toBe(`${BASE}/vaults/${VAULT_ID}/credentials/vcrd_1`);
			expect(calls[0]!.method).toBe("GET");
			expect(result.id).toBe("vcrd_1");
		});

		test("updateCredential POSTs patch", async () => {
			const { calls, restore } = mockFetch([{ status: 200, body: { ...CRED_RESPONSE, display_name: "new" } }]);
			cleanup = restore;

			await makeAdapter().updateCredential(VAULT_ID, "vcrd_1", {
				display_name: "new",
			});

			expect(calls[0]!.url).toBe(`${BASE}/vaults/${VAULT_ID}/credentials/vcrd_1`);
			expect(calls[0]!.method).toBe("POST");
			expect(calls[0]!.body).toEqual({ display_name: "new" });
		});

		test("updateCredential sends fixed injection policy while preserving an omitted secret", async () => {
			const { calls, restore } = mockFetch([{ status: 200, body: CRED_RESPONSE }]);
			cleanup = restore;
			const auth = {
				type: "environment_variable" as const,
				secret_name: "API_TOKEN",
				networking: { allowed_hosts: ["api.example.com", "*.example.org"] },
			};
			await makeAdapter().updateCredential(VAULT_ID, "vcrd_1", { auth });
			expect(calls[0]!.url).toBe(`${BASE}/vaults/${VAULT_ID}/credentials/vcrd_1`);
			expect(calls[0]!.method).toBe("POST");
			expect(calls[0]!.body).toEqual({ auth: { ...auth, injection_location: { header: true, body: false } } });
		});

		test.each([
			{ header: true, body: false },
			{ header: false, body: true },
		])("rejects explicit injection policy before vault, credential, or auth update requests: %j", async (injectionLocation) => {
			const { calls, restore } = mockFetch([]);
			cleanup = restore;
			const customized = {
				name: "token",
				type: "environment_variable" as const,
				secret_name: "TOKEN",
				secret_value: "never-expose-this",
				injection_location: injectionLocation,
			};
			const adapter = makeAdapter();
			await expect(
				adapter.createVault("secrets", { display_name: "Secrets", credentials: [customized] }),
			).rejects.toThrow(/cannot be configured/);
			await expect(adapter.createCredential(VAULT_ID, customized)).rejects.toThrow(/cannot be configured/);
			await expect(adapter.updateCredential(VAULT_ID, "vcrd_1", { auth: customized })).rejects.toThrow(
				/cannot be configured/,
			);
			expect(calls).toHaveLength(0);
		});

		test("archiveCredential POSTs .../archive", async () => {
			const { calls, restore } = mockFetch([{ status: 200, body: CRED_RESPONSE }]);
			cleanup = restore;

			await makeAdapter().archiveCredential(VAULT_ID, "vcrd_1");

			expect(calls[0]!.url).toBe(`${BASE}/vaults/${VAULT_ID}/credentials/vcrd_1/archive`);
			expect(calls[0]!.method).toBe("POST");
		});

		test("deleteCredential sends DELETE", async () => {
			const { calls, restore } = mockFetch([{ status: 200 }]);
			cleanup = restore;

			await makeAdapter().deleteCredential(VAULT_ID, "vcrd_1");

			expect(calls[0]!.url).toBe(`${BASE}/vaults/${VAULT_ID}/credentials/vcrd_1`);
			expect(calls[0]!.method).toBe("DELETE");
		});
	});

	// ---- Unsupported operations ----

	describe("Unsupported operations", () => {
		test("memory_store methods are omitted (not stubbed)", () => {
			const adapter = makeAdapter() as unknown as Record<string, unknown>;
			expect(typeof adapter.createMemoryStore).not.toBe("function");
			expect(typeof adapter.deleteMemoryStore).not.toBe("function");
		});
	});

	// ---- Client configuration ----

	describe("Client configuration", () => {
		test("default base URL uses workspace_id template", async () => {
			const { calls, restore } = mockFetch([{ status: 200, body: { data: [] } }]);
			cleanup = restore;

			await makeAdapter().validate();
			expect(calls[0]!.url).toStartWith("https://ws-test.cn-beijing.maas.aliyuncs.com/api/v1/agentstudio");
		});

		test("custom base_url overrides default", async () => {
			const { calls, restore } = mockFetch([{ status: 200, body: { data: [] } }]);
			cleanup = restore;

			await makeAdapter("https://custom.example.com/api/v1/agentstudio").validate();
			expect(calls[0]!.url).toStartWith("https://custom.example.com/api/v1/agentstudio");
		});

		test("Authorization header uses Bearer token", async () => {
			const { restore } = mockFetch([{ status: 200, body: { data: [] } }]);
			cleanup = restore;

			await makeAdapter().validate();
			const headers = (globalThis.fetch as any).mock.calls[0][1].headers;
			expect(headers.Authorization).toBe("Bearer sk-test-key");
		});
	});

	// ---- Error propagation ----

	describe("Error propagation", () => {
		test("4xx error includes status code and body", async () => {
			const { restore } = mockFetch([
				{
					status: 404,
					body: {
						type: "error",
						error: {
							code: "not_found_error",
							message: "environment not found",
						},
					},
				},
			]);
			cleanup = restore;

			await expect(makeAdapter().createEnvironment("env", { config: { type: "cloud" } })).rejects.toThrow(/404/);
		});

		test("5xx error propagates", async () => {
			const { restore } = mockFetch([
				{
					status: 500,
					body: {
						type: "error",
						error: { code: "internal", message: "server error" },
					},
				},
			]);
			cleanup = restore;

			await expect(
				makeAdapter().createAgent("a", { model: "qwen3.7-max", instructions: "test" }, { skill_ids: [] }),
			).rejects.toThrow(/500/);
		});
	});

	// ---- Pagination & server-side-filter regressions ----
	//
	// The org routinely spans multiple pages (267 agents / 121 environments live),
	// and the `/agents` `keyword` param is a no-op (returns the full unfiltered
	// page). These tests lock in that name lookups and the resource-center lists
	// scan every page and filter locally, so members on page 2+ are never dropped.

	describe("pagination and filtering regressions", () => {
		test("listAgents with prefix paginates every page and filters locally (keyword never sent)", async () => {
			const { calls, restore } = mockFetch([
				// page 1: only non-Agents agents + a forward cursor
				{
					status: 200,
					body: {
						data: [{ ...AGENT_RESPONSE, id: "a1", name: "data-analyst" }],
						next_page: "P2",
					},
				},
				// page 2: the Agents member lives here — it must survive the local filter
				{
					status: 200,
					body: {
						data: [
							{ ...AGENT_RESPONSE, id: "a_agents", name: "Agents/运营专家" },
							{ ...AGENT_RESPONSE, id: "a2", name: "bailian-cli" },
						],
						next_page: null,
					},
				},
			]);
			cleanup = restore;

			const result = await makeAdapter().listAgents({
				prefix: "Agents/",
				limit: 100,
			});

			expect(calls.map((c) => c.url)).toEqual([
				`${BASE}/agents?include_archived=true&limit=100`,
				`${BASE}/agents?include_archived=true&limit=100&page=P2`,
			]);
			expect(calls.every((c) => !c.url.includes("keyword"))).toBe(true);
			expect(result.map((a) => a.name)).toEqual(["Agents/运营专家"]);
		});

		test("listAgents without prefix takes a single page honoring limit", async () => {
			const { calls, restore } = mockFetch([{ status: 200, body: { data: [AGENT_RESPONSE], next_page: "P2" } }]);
			cleanup = restore;

			const result = await makeAdapter().listAgents({ limit: 25 });

			expect(calls).toHaveLength(1);
			expect(calls[0]!.url).toBe(`${BASE}/agents?limit=25`);
			expect(result).toHaveLength(1);
		});

		test("listEnvironments paginates across every page", async () => {
			const { calls, restore } = mockFetch([
				{ status: 200, body: { data: [ENV_RESPONSE], next_page: "E2" } },
				{
					status: 200,
					body: {
						data: [{ ...ENV_RESPONSE, id: "env_2", name: "staging" }],
						next_page: null,
					},
				},
			]);
			cleanup = restore;

			const result = await makeAdapter().listEnvironments();

			expect(calls.map((c) => c.url)).toEqual([
				`${BASE}/environments?limit=100`,
				`${BASE}/environments?limit=100&page=E2`,
			]);
			expect(result.map((e) => e.id)).toEqual(["env_OWNjZGNmZjRkMzk1NDVlYT", "env_2"]);
		});

		test("findResource follows pagination to a name on a later page", async () => {
			const { calls, restore } = mockFetch([
				{
					status: 200,
					body: {
						data: [{ id: "env_1", name: "other", type: "environment" }],
						next_page: "E2",
					},
				},
				{ status: 200, body: { data: [ENV_RESPONSE], next_page: null } },
			]);
			cleanup = restore;

			const result = await makeAdapter().findResource("environment", "dev-env");

			expect(calls).toHaveLength(2);
			expect(result!.id).toBe("env_OWNjZGNmZjRkMzk1NDVlYT");
		});

		test("readComparableResource follows pagination to an agent by name", async () => {
			const { calls, restore } = mockFetch([
				{
					status: 200,
					body: {
						data: [{ ...AGENT_RESPONSE, id: "other", name: "nope" }],
						next_page: "P2",
					},
				},
				{ status: 200, body: { data: [AGENT_RESPONSE], next_page: null } },
			]);
			cleanup = restore;

			const result = await makeAdapter().readComparableResource("agent", null, "helper");

			expect(calls).toHaveLength(2);
			expect(result!.id).toBe("agent_01HKDPNVR8YZ7VBHKPK9CYNVTA");
		});
	});
});
