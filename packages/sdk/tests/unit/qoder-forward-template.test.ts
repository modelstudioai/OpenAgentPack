import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { validateProjectConfig } from "../../src/internal/core/validate-config.ts";
import { executePlan } from "../../src/internal/executor/executor.ts";
import { resolveTemplateRefs } from "../../src/internal/executor/resolver.ts";
import { buildDependencyGraph } from "../../src/internal/graph/dependency.ts";
import { computeResourceHash } from "../../src/internal/planner/hasher.ts";
import { buildPlan } from "../../src/internal/planner/planner.ts";
import { ApiError } from "../../src/internal/providers/base-client.ts";
import type { ProviderAdapter } from "../../src/internal/providers/interface.ts";
import { QoderAdapter } from "../../src/internal/providers/qoder/adapter.ts";
import { mapForwardTemplate } from "../../src/internal/providers/qoder/mapper.ts";
import { buildSessionBindings } from "../../src/internal/session/session-manager.ts";
import { StateManager } from "../../src/internal/state/state-manager.ts";
import type { ProjectConfig } from "../../src/internal/types/config.ts";
import type { StateFile } from "../../src/internal/types/state.ts";
import "../../src/internal/providers/all.ts";

function tmpPath(label: string): string {
	return join(tmpdir(), `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

function forwardConfig(): ProjectConfig {
	return {
		version: "1",
		providers: { qoder: { api_key: "test" } },
		defaults: { provider: "qoder" },
		environments: {
			byoc: { environment_id: "env_byoc", config: { type: "self_hosted" } },
		},
		tunnels: { internal: { tunnel_id: "tnl_internal" } },
		vaults: {
			mcp: {
				display_name: "MCP",
				credentials: [
					{
						name: "coop",
						type: "static_bearer",
						mcp_server_url: "https://mcp.example.test/mcp",
						access_token: "secret",
					},
				],
			},
		},
		agents: {
			assistant: {
				description: "BYOC assistant",
				model: { qoder: "auto" },
				instructions: "Use internal tools.",
				environment: "byoc",
				tunnel: "internal",
				vault: "mcp",
				tools: { builtin: ["Bash", "Read"], permissions: { bash: "ask" } },
				mcp_servers: [{ name: "coop", type: "http", url: "https://mcp.example.test/mcp" }],
				environment_variables: { BASE_MODE: "support" },
				delivery: { qoder: { type: "forward" } },
			},
		},
	};
}

describe("Qoder Forward Template declaration", () => {
	test("makes the default Identity a Template dependency when default memory is configured", () => {
		const config = forwardConfig();
		config.defaults = { provider: "qoder", identity: "zhang" };
		config.identities = { zhang: { external_id: "zhang" } };
		config.agents!.assistant!.default_memory_store = { name: "Support memory" };
		const graph = buildDependencyGraph(config, ["qoder"]);
		expect([...graph.edges.get("qoder.template.assistant")!]).toContain("qoder.identity.zhang");
	});

	test("materializes a forward-delivered agent as a template graph resource", async () => {
		const config = forwardConfig();
		const graph = buildDependencyGraph(config, ["qoder"]);
		expect([...graph.nodes.keys()]).toContain("qoder.template.assistant");
		expect([...graph.nodes.keys()]).not.toContain("qoder.agent.assistant");
		expect([...graph.edges.get("qoder.template.assistant")!].sort()).toEqual([
			"qoder.environment.byoc",
			"qoder.vault.mcp",
		]);

		const plan = await buildPlan(config, { resources: [] });
		expect(plan.diagnostics).toEqual([]);
		expect(plan.actions.map((action) => `${action.action}:${action.address.type}:${action.address.name}`)).toEqual([
			"create:environment:byoc",
			"create:vault:mcp",
			"create:template:assistant",
		]);
	});

	test("keeps managed delivery as the backward-compatible default", async () => {
		const config = forwardConfig();
		delete config.agents!.assistant!.delivery;
		const plan = await buildPlan(config, { resources: [] });
		expect(plan.actions.some((action) => action.address.type === "agent")).toBe(true);
		expect(plan.actions.some((action) => action.address.type === "template")).toBe(false);
	});

	test("plans create-template then delete-agent when delivery changes", async () => {
		const config = forwardConfig();
		const state: StateFile = {
			resources: [
				{
					address: { type: "agent", name: "assistant", provider: "qoder" },
					remote_id: "agent_old",
					content_hash: "old",
				},
			],
		};
		const plan = await buildPlan(config, state);
		const templateIndex = plan.actions.findIndex(
			(action) => action.action === "create" && action.address.type === "template",
		);
		const deleteIndex = plan.actions.findIndex(
			(action) => action.action === "delete" && action.address.type === "agent",
		);
		expect(templateIndex).toBeGreaterThanOrEqual(0);
		expect(deleteIndex).toBeGreaterThan(templateIndex);
		expect(plan.actions[deleteIndex]!.dependencies).toEqual([
			{ type: "template", name: "assistant", provider: "qoder" },
		]);
	});

	test("keeps the old managed Agent when replacement Template creation fails", async () => {
		const config = forwardConfig();
		delete config.agents!.assistant!.vault;
		delete config.vaults;
		const state = StateManager.initialize(tmpPath("forward-replacement"));
		state.setResource({
			address: { type: "agent", name: "assistant", provider: "qoder" },
			remote_id: "agent_old",
			content_hash: "old",
		});
		const plan = await buildPlan(config, state.getStateFile());
		let deleted = false;
		const provider = {
			name: "qoder",
			findResource: async () => null,
			createTemplate: async () => {
				throw new Error("template create failed");
			},
			updateTemplate: async () => ({ id: "tmpl_1", type: "template" }),
			archiveTemplate: async () => {},
			deleteAgent: async () => {
				deleted = true;
			},
		} as unknown as ProviderAdapter;

		const result = await executePlan(plan, {
			config,
			providers: new Map([["qoder", provider]]),
			state,
		});

		expect(result.partial).toBe(true);
		expect(deleted).toBe(false);
		expect(state.getResource({ type: "agent", name: "assistant", provider: "qoder" })?.remote_id).toBe("agent_old");
	});

	test("includes resolved tunnel and vault ids in the desired hash", async () => {
		const config = forwardConfig();
		const lookup = {
			getResource: ({ type }: { type: string }) =>
				type === "vault" ? { remote_id: "vault_one" } : { remote_id: "unused" },
		};
		const address = { type: "template", name: "assistant", provider: "qoder" } as const;
		const first = await computeResourceHash(address, config, undefined, lookup);
		config.tunnels!.internal!.tunnel_id = "tnl_changed";
		const second = await computeResourceHash(address, config, undefined, lookup);
		expect(second).not.toBe(first);
	});

	test("changes dependent resource hashes when Qoder switches API domains", async () => {
		const config = forwardConfig();
		const address = { type: "vault", name: "mcp", provider: "qoder" } as const;
		const forwardHash = await computeResourceHash(address, config);
		delete config.agents!.assistant!.delivery;
		const managedHash = await computeResourceHash(address, config);
		expect(forwardHash).not.toBe(managedHash);
	});

	test("keeps an unrelated Managed File in the Managed API domain", async () => {
		const config = forwardConfig();
		config.files = { handbook: { source: "README.md" } };
		const address = { type: "file", name: "handbook", provider: "qoder" } as const;
		const withForwardAgent = await computeResourceHash(address, config);
		delete config.agents;
		const managedOnly = await computeResourceHash(address, config);
		expect(withForwardAgent).toBe(managedOnly);
	});
});

describe("Qoder Forward Template mapping and lifecycle", () => {
	test("routes self-created Forward Environments without changing Managed Environment routing", async () => {
		const calls: string[] = [];
		const adapter = new QoderAdapter("pt-test") as any;
		adapter.client = {
			post: async (path: string) => {
				calls.push(`managed POST ${path}`);
				return { id: "env_managed" };
			},
		};
		adapter.forwardClient = {
			post: async (path: string, body: Record<string, any>) => {
				calls.push(`forward POST ${path}`);
				expect(body.config.networking).toBeUndefined();
				return { id: "env_forward" };
			},
		};
		await adapter.createEnvironment("managed", { config: { type: "cloud" } }, "managed");
		await adapter.createEnvironment(
			"forward",
			{ config: { type: "cloud", networking: { type: "unrestricted" } } },
			"forward",
		);
		expect(calls).toEqual(["managed POST /environments", "forward POST /environments"]);
	});

	test("resolves an external Environment id from either API domain", async () => {
		const calls: string[] = [];
		const adapter = new QoderAdapter("pt-test") as any;
		adapter.client = {
			get: async (path: string) => {
				calls.push(`managed GET ${path}`);
				throw new ApiError(404, "not found", "test");
			},
		};
		adapter.forwardClient = {
			get: async (path: string) => {
				calls.push(`forward GET ${path}`);
				return { id: "env_forward", type: "environment", name: "external" };
			},
		};

		const found = await adapter.findResource("environment", "external", "env_forward", "auto");
		expect(found?.id).toBe("env_forward");
		expect(calls).toEqual(["managed GET /environments/env_forward", "forward GET /environments/env_forward"]);
	});

	test("maps BYOC bindings and tool permissions", () => {
		const decl = forwardConfig().agents!.assistant!;
		decl.environment_variables = { BASE_MODE: "support" };
		const body = mapForwardTemplate("assistant", decl, {
			environment_id: "env_byoc",
			tunnel_id: "tnl_internal",
			vault_ids: ["vault_mcp"],
			skill_ids: [],
		}) as Record<string, any>;
		expect(body).toMatchObject({
			name: "assistant",
			model: "auto",
			environment_id: "env_byoc",
			tunnel_id: "tnl_internal",
			vault_ids: ["vault_mcp"],
			mcp_servers: [{ name: "coop", type: "http", url: "https://mcp.example.test/mcp" }],
			environment_variables: { BASE_MODE: "support" },
		});
		expect(body.tools[0].configs).toEqual([
			{
				name: "Bash",
				enabled: true,
				permission_policy: { type: "always_ask" },
			},
			{ name: "Read", enabled: true, permission_policy: { type: "always_allow" } },
		]);
	});

	test("passes managed_tool_config through so schedule tools survive an update", () => {
		const decl = forwardConfig().agents!.assistant!;
		decl.managed_tool_config = {
			enabled_tools: ["create_forward_schedule", "list_forward_schedules", "delete_forward_schedule"],
		};
		const body = mapForwardTemplate("assistant", decl, {
			environment_id: "env_byoc",
			tunnel_id: "tnl_internal",
			vault_ids: [],
			skill_ids: [],
		}) as Record<string, any>;
		expect(body.managed_tool_config).toEqual({
			enabled_tools: ["create_forward_schedule", "list_forward_schedules", "delete_forward_schedule"],
		});
	});

	test("omits managed_tool_config when undeclared so an existing remote set is preserved", () => {
		const decl = forwardConfig().agents!.assistant!;
		const body = mapForwardTemplate("assistant", decl, {
			environment_id: "env_byoc",
			vault_ids: [],
			skill_ids: [],
		}) as Record<string, any>;
		expect("managed_tool_config" in body).toBe(false);
	});

	test("sends an explicit empty enabled_tools so managed tools can be turned off", () => {
		const decl = forwardConfig().agents!.assistant!;
		decl.managed_tool_config = { enabled_tools: [] };
		const body = mapForwardTemplate("assistant", decl, {
			environment_id: "env_byoc",
			vault_ids: [],
			skill_ids: [],
		}) as Record<string, any>;
		expect(body.managed_tool_config).toEqual({ enabled_tools: [] });
	});

	test("uses the Forward endpoints for create, update, archive, and lookup", async () => {
		const calls: Array<{ method: string; path: string; body?: unknown }> = [];
		const adapter = new QoderAdapter("pt-test") as any;
		adapter.forwardClient = {
			post: async (path: string, body: unknown) => {
				calls.push({ method: "POST", path, body });
				return { id: "tmpl_1", type: "template", name: "assistant", status: "active" };
			},
			get: async (path: string) => {
				calls.push({ method: "GET", path });
				return { id: "tmpl_1", type: "template", name: "assistant", status: "active" };
			},
			getAllPaged: async () => [],
		};
		const decl = forwardConfig().agents!.assistant!;
		const refs = {
			environment_id: "env_byoc",
			tunnel_id: "tnl_internal",
			vault_ids: ["vault_mcp"],
			skill_ids: [],
		};

		await adapter.createTemplate("assistant", decl, refs);
		await adapter.updateTemplate("tmpl_1", "assistant", decl, refs);
		await adapter.archiveTemplate("tmpl_1");
		await adapter.findResource("template", "assistant", "tmpl_1");

		expect(calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
			"POST /templates",
			"POST /templates/tmpl_1",
			"POST /templates/tmpl_1/archive",
			"GET /templates/tmpl_1",
		]);
	});

	test("appends Skill versions in both API domains and keeps Forward Vault credentials isolated", async () => {
		const managedCalls: string[] = [];
		const forwardCalls: string[] = [];
		const adapter = new QoderAdapter("pt-test") as any;
		adapter.client = {
			post: async (path: string) => managedCalls.push(`POST ${path}`),
			postFormData: async (path: string) => managedCalls.push(`POST_FORM ${path}`),
			get: async (path: string) => {
				managedCalls.push(`GET ${path}`);
				return { id: "skill_managed" };
			},
			delete: async (path: string) => managedCalls.push(`DELETE ${path}`),
		};
		adapter.forwardClient = {
			post: async (path: string) => {
				forwardCalls.push(`POST ${path}`);
				return path === "/vaults" ? { id: "vault_forward" } : {};
			},
			postFormData: async (path: string) => {
				forwardCalls.push(`POST_FORM ${path}`);
				return { id: "skill_forward" };
			},
			get: async (path: string) => {
				forwardCalls.push(`GET ${path}`);
				return { id: "skill_forward" };
			},
			delete: async (path: string) => forwardCalls.push(`DELETE ${path}`),
		};

		await adapter.createSkill("forward-skill", { source: "." }, [], "forward");
		await adapter.updateSkill("skill_forward", "forward-skill", { source: "." }, [], "forward");
		await adapter.updateSkill("skill_managed", "managed-skill", { source: "." }, [], "managed");
		await adapter.deleteSkill("skill_forward", "forward");
		await adapter.createVault(
			"forward-vault",
			{
				display_name: "Forward vault",
				credentials: [{ name: "api", type: "static_bearer", access_token: "secret" }],
			},
			"forward",
		);
		await adapter.deleteVault("vault_forward", "forward");

		expect(managedCalls).toEqual(["POST_FORM /skills/skill_managed/versions", "GET /skills/skill_managed"]);
		expect(forwardCalls).toEqual([
			"POST_FORM /skills",
			"POST_FORM /skills/skill_forward/versions",
			"GET /skills/skill_forward",
			"DELETE /skills/skill_forward",
			"POST /vaults",
			"POST /vaults/vault_forward/credentials",
			"DELETE /vaults/vault_forward",
		]);
	});

	test("packages Skill versions under the SKILL.md manifest name", async () => {
		let entries: string[] = [];
		const adapter = new QoderAdapter("pt-test") as any;
		adapter.client = {
			postFormData: async (_path: string, form: FormData) => {
				const archive = form.get("files") as File;
				const zip = await JSZip.loadAsync(await archive.arrayBuffer());
				entries = Object.keys(zip.files);
			},
			get: async () => ({ id: "skill_1" }),
		};
		await adapter.updateSkill(
			"skill_1",
			"display-alias",
			{ source: "." },
			[
				{
					relativePath: "SKILL.md",
					content: "---\nname: manifest-name\ndescription: test\n---\n",
				},
			],
			"managed",
		);
		expect(entries).toContain("manifest-name/SKILL.md");
		expect(entries).not.toContain("display-alias/SKILL.md");
	});

	test("creates Forward Memory Stores with idempotency and reconciles Identity mounts", async () => {
		const calls: Array<{ method: string; path: string; body?: unknown; options?: unknown }> = [];
		const adapter = new QoderAdapter("pt-test") as any;
		adapter.forwardClient = {
			post: async (path: string, body: unknown, options?: unknown) => {
				calls.push({ method: "POST", path, body, options });
				if (path === "/memory_stores") return { id: "memstore_forward" };
				if (path === "/templates") return { id: "tmpl_forward" };
				return {};
			},
			get: async (path: string) => {
				calls.push({ method: "GET", path });
				return {
					data: [
						{ memory_store_id: "memstore_old", system_managed: false },
						{ memory_store_id: "memstore_external", system_managed: false },
					],
				};
			},
			delete: async (path: string) => calls.push({ method: "DELETE", path }),
		};
		adapter.forwardMemoryApi = { createMemory: async () => ({}) };

		await adapter.createMemoryStore("forward-memory", { description: "Forward memory" }, "forward");
		await adapter.createTemplate("assistant", forwardConfig().agents!.assistant!, {
			environment_id: "env_byoc",
			vault_ids: [],
			skill_ids: [],
			identity_id: "idn_1",
			memory_store_ids: ["memstore_forward"],
			owned_memory_store_ids: ["memstore_old", "memstore_forward"],
		});

		const createStore = calls.find((call) => call.path === "/memory_stores");
		expect(createStore?.options).toMatchObject({ headers: { "Idempotency-Key": expect.any(String) } });
		expect(calls.map(({ method, path }) => `${method} ${path}`)).toContain(
			"DELETE /identities/idn_1/templates/tmpl_forward/memory_stores/memstore_old",
		);
		expect(calls.map(({ method, path }) => `${method} ${path}`)).not.toContain(
			"DELETE /identities/idn_1/templates/tmpl_forward/memory_stores/memstore_external",
		);
		expect(calls.find((call) => call.path.startsWith("/identities/") && call.body)?.body).toEqual({
			memory_store_id: "memstore_forward",
		});
	});

	test("permanently deletes an explicit Forward Memory Store through the Cloud endpoint", async () => {
		const managedCalls: string[] = [];
		const forwardCalls: string[] = [];
		const adapter = new QoderAdapter("pt-test") as any;
		adapter.client = {
			delete: async (path: string) => managedCalls.push(`DELETE ${path}`),
		};
		adapter.forwardClient = {
			delete: async (path: string) => forwardCalls.push(`DELETE ${path}`),
		};

		await adapter.deleteMemoryStore("memstore_forward", "forward");

		expect(managedCalls).toEqual(["DELETE /memory_stores/memstore_forward"]);
		expect(forwardCalls).toEqual([]);
	});

	test("rolls back a partially created Forward Memory Store through the Cloud endpoint", async () => {
		const managedCalls: string[] = [];
		const forwardCalls: string[] = [];
		const adapter = new QoderAdapter("pt-test") as any;
		adapter.client = {
			delete: async (path: string) => managedCalls.push(`DELETE ${path}`),
		};
		adapter.forwardClient = {
			post: async (path: string) => {
				forwardCalls.push(`POST ${path}`);
				return { id: "memstore_partial" };
			},
			delete: async (path: string) => forwardCalls.push(`DELETE ${path}`),
		};
		adapter.forwardMemoryApi = {
			createMemory: async () => {
				throw new Error("entry upload failed");
			},
		};

		await expect(
			adapter.createMemoryStore("partial", { entries: [{ key: "MEMORY.md", content: "partial" }] }, "forward"),
		).rejects.toThrow("entry upload failed");

		expect(managedCalls).toEqual(["DELETE /memory_stores/memstore_partial"]);
		expect(forwardCalls).toEqual(["POST /memory_stores"]);
	});

	test("detaches only project-owned Memory Store mounts while archiving a Template", async () => {
		const calls: string[] = [];
		const adapter = new QoderAdapter("pt-test") as any;
		adapter.forwardClient = {
			getAllPaged: async () => [{ id: "idn_1" }],
			get: async () => ({
				data: [
					{ memory_store_id: "memstore_owned", system_managed: false },
					{ memory_store_id: "memstore_external", system_managed: false },
					{ memory_store_id: "memstore_default", system_managed: true },
				],
			}),
			delete: async (path: string) => calls.push(`DELETE ${path}`),
			post: async (path: string) => calls.push(`POST ${path}`),
		};
		await adapter.archiveTemplate("tmpl_1", ["memstore_owned"]);
		expect(calls).toEqual([
			"DELETE /identities/idn_1/templates/tmpl_1/memory_stores/memstore_owned",
			"POST /templates/tmpl_1/archive",
		]);
	});

	test("maps Forward Template file references using Forward file ids", () => {
		const decl = forwardConfig().agents!.assistant!;
		decl.files = ["handbook"];
		const body = mapForwardTemplate("assistant", decl, {
			environment_id: "env_forward",
			vault_ids: [],
			skill_ids: [],
			file_ids: ["file_forward"],
		}) as Record<string, unknown>;
		expect(body.files).toEqual({ file_forward: { enabled: true } });
	});

	test("sends an empty File map and Memory Store set when bindings are removed", async () => {
		const config = forwardConfig();
		config.defaults = { provider: "qoder", identity: "user" };
		config.identities = { user: { external_id: "user" } };
		delete config.agents!.assistant!.vault;
		const state = StateManager.initialize(tmpPath("forward-empty-bindings"));
		state.setResource({
			address: { type: "identity", name: "user", provider: "qoder" },
			remote_id: "idn_1",
			content_hash: "identity",
		});
		const refs = resolveTemplateRefs("assistant", config, "qoder", state);
		expect(refs).toMatchObject({
			file_ids: [],
			memory_store_ids: [],
			owned_memory_store_ids: [],
			identity_id: "idn_1",
		});
		const body = mapForwardTemplate("assistant", config.agents!.assistant!, refs) as Record<string, unknown>;
		expect(body.files).toEqual({});
	});

	test("reads a full Template drift snapshot including BYOC bindings", async () => {
		const adapter = new QoderAdapter("pt-test") as any;
		adapter.forwardClient = {
			get: async () => ({
				id: "tmpl_1",
				type: "template",
				status: "active",
				name: "assistant",
				model: "auto",
				system: "Use internal tools.",
				environment_id: "env_byoc",
				tunnel_id: "tnl_internal",
				vault_ids: ["vault_mcp"],
				metadata: { "agents.project": "ignored", business: "kept" },
			}),
			getAllPaged: async () => [],
		};

		const remote = await adapter.readComparableResource("template", "tmpl_1", "assistant");
		expect(remote?.comparable).toMatchObject({
			name: "assistant",
			environment_id: "env_byoc",
			tunnel_id: "tnl_internal",
			vault_ids: ["vault_mcp"],
			metadata: { business: "kept" },
		});
	});

	test("uses the explicit Identity without creating one and routes sessions through the Forward gateway", async () => {
		const calls: Array<{ method: string; path: string; body?: unknown; options?: unknown }> = [];
		const adapter = new QoderAdapter("pt-test") as any;
		adapter.client = {
			post: async (path: string) => {
				throw new Error(`managed gateway must not receive ${path}`);
			},
		};
		adapter.forwardClient = {
			get: async (path: string) => {
				calls.push({ method: "GET", path });
				if (path.startsWith("/sessions/sess_forward/events?")) {
					return {
						data: [
							{ id: "evt_tool", type: "agent.mcp_tool_use", mcp_server_name: "coop", name: "search" },
							{ id: "evt_idle", type: "session.status_idle" },
						],
						has_more: false,
						last_id: "evt_idle",
					};
				}
				throw new Error(`unexpected GET ${path}`);
			},
			post: async (path: string, body: unknown) => {
				calls.push({ method: "POST", path, body });
				if (path === "/sessions") {
					return {
						id: "sess_forward",
						status: "idle",
						template: { id: "tmpl_1" },
						identity_id: "idn_cli",
						created_at: "2026-01-01T00:00:00Z",
						updated_at: "2026-01-01T00:00:01Z",
					};
				}
				if (path.endsWith("/events")) return { data: [{ id: "evt_user" }] };
				return {};
			},
			sse: async function* (path: string, options?: unknown) {
				calls.push({ method: "SSE", path, options });
				yield { id: "evt_idle", type: "session.status_idle" };
			},
		};

		const created = await adapter.createSession({
			delivery: "forward",
			template_id: "tmpl_1",
			identity_id: "idn_zhang",
			title: "Forward test",
			environment_variables: { API_KEY: "secret", REGION: "cn-hangzhou" },
		});
		const eventId = await adapter.sendSessionMessage(created.id, "hello");
		const listed = await adapter.listSessionEvents(created.id, { limit: 100 });
		const streamed = [];
		for await (const event of adapter.streamSessionEvents(created.id, { after_id: eventId })) streamed.push(event);
		await adapter.deleteSession(created.id);

		expect(created).toMatchObject({ id: "sess_forward", agent_id: "tmpl_1", status: "idle" });
		expect(calls.find((call) => call.path === "/sessions")?.body).toMatchObject({
			identity_id: "idn_zhang",
			template_id: "tmpl_1",
			config: { environment_variables: { API_KEY: "secret", REGION: "cn-hangzhou" } },
		});
		expect(eventId).toBe("evt_user");
		expect(listed.events[0]).toMatchObject({ type: "tool_use", tool_name: "search" });
		expect(streamed.at(-1)).toMatchObject({ type: "status", status: "idle" });
		expect(calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
			"POST /sessions",
			"POST /sessions/sess_forward/events",
			"GET /sessions/sess_forward/events?limit=100",
			"SSE /sessions/sess_forward/events/stream",
			"POST /sessions/sess_forward/archive",
		]);
	});

	test("requires the core runtime to resolve an explicit Identity", async () => {
		const adapter = new QoderAdapter("pt-test") as any;
		adapter.forwardClient = {
			post: async () => {
				throw new Error("session must not be created");
			},
		};

		await expect(adapter.createSession({ delivery: "forward", template_id: "tmpl_1" })).rejects.toThrow(
			/explicit resolved identity_id/,
		);
	});
});

describe("Forward delivery validation and runtime isolation", () => {
	test("rejects Agent files outside Qoder Forward Templates", () => {
		const config: ProjectConfig = {
			version: "1",
			providers: { claude: { api_key: "test" } },
			defaults: { provider: "claude" },
			files: { handbook: { source: "README.md" } },
			agents: {
				assistant: {
					provider: "claude",
					model: { claude: "claude-sonnet-4-5" },
					instructions: "test",
					files: ["handbook"],
				},
			},
		};
		expect(validateProjectConfig(config).some((item) => item.code === "config.agent.files.unsupported")).toBe(true);
	});

	test("migrates a locally owned Environment between API domains without orphaning the old resource", async () => {
		const config = forwardConfig();
		config.environments!.byoc = { config: { type: "cloud" } };
		const state = StateManager.initialize(tmpPath("forward-environment-domain"));
		state.setResource({
			address: { type: "environment", name: "byoc", provider: "qoder" },
			remote_id: "env_managed",
			content_hash: "old",
			api_mode: "managed",
		});
		const calls: string[] = [];
		const provider = {
			name: "qoder",
			createEnvironment: async (_name: string, _decl: unknown, mode: unknown) => {
				calls.push(`create:${mode}`);
				return { id: "env_forward", type: "environment" };
			},
			deleteEnvironment: async (id: string, _cascade: boolean, mode: unknown) => {
				calls.push(`delete:${id}:${mode}`);
			},
		} as unknown as ProviderAdapter;
		await executePlan(
			{
				actions: [
					{
						action: "update",
						address: { type: "environment", name: "byoc", provider: "qoder" },
						dependencies: [],
					},
				],
				diagnostics: [],
			},
			{ config, providers: new Map([["qoder", provider]]), state },
		);
		expect(calls).toEqual(["create:forward", "delete:env_managed:managed"]);
		expect(state.getResource({ type: "environment", name: "byoc", provider: "qoder" })?.remote_id).toBe("env_forward");
	});

	test("rejects sharing locally owned Environments and Files but allows an external Environment reference", () => {
		const config = forwardConfig();
		config.environments!.byoc = { config: { type: "cloud" } };
		config.files = { handbook: { source: "README.md" } };
		config.agents!.assistant!.files = ["handbook"];
		config.agents!.managed = {
			model: { qoder: "auto" },
			instructions: "Managed.",
			environment: "byoc",
			files: ["handbook"],
		};
		let diagnostics = validateProjectConfig(config);
		expect(diagnostics.some((item) => item.code === "qoder.environment.delivery_domain.conflict")).toBe(true);
		expect(diagnostics.some((item) => item.code === "qoder.file.delivery_domain.conflict")).toBe(true);

		config.environments!.byoc!.environment_id = "env_existing";
		diagnostics = validateProjectConfig(config);
		expect(diagnostics.some((item) => item.code === "qoder.environment.delivery_domain.conflict")).toBe(false);
	});

	test("rejects sharing one Qoder Vault across Managed and Forward API domains", () => {
		const config = forwardConfig();
		config.agents!.managed = {
			description: "Managed assistant",
			model: { qoder: "auto" },
			instructions: "Managed.",
			vault: "mcp",
		};
		const diagnostics = validateProjectConfig(config);
		expect(diagnostics.some((item) => item.code === "qoder.vault.delivery_domain.conflict")).toBe(true);
	});

	test("passes the Forward API domain through apply and persists it in state", async () => {
		const config = forwardConfig();
		const state = StateManager.initialize(tmpPath("forward-vault-domain"));
		const modes: unknown[] = [];
		const provider = {
			name: "qoder",
			findResource: async () => null,
			createVault: async (_name: string, _decl: unknown, mode: unknown) => {
				modes.push(mode);
				return { id: "vault_forward", type: "vault" };
			},
			deleteVault: async () => {},
		} as unknown as ProviderAdapter;
		await executePlan(
			{
				actions: [
					{
						action: "create",
						address: { type: "vault", name: "mcp", provider: "qoder" },
						dependencies: [],
					},
				],
				diagnostics: [],
			},
			{ config, providers: new Map([["qoder", provider]]), state },
		);
		expect(modes).toEqual(["forward"]);
		expect(state.getResource({ type: "vault", name: "mcp", provider: "qoder" })?.api_mode).toBe("forward");
	});

	test("requires a default Identity for default memory reconciliation", () => {
		const config = forwardConfig();
		config.agents!.assistant!.default_memory_store = { name: "Support memory" };
		const diagnostics = validateProjectConfig(config);
		expect(diagnostics.some((item) => item.code === "qoder.template.default_memory_store.identity.required")).toBe(
			true,
		);
	});

	test("accepts default memory metadata for Qoder Forward delivery", () => {
		const config = forwardConfig();
		config.defaults = { provider: "qoder", identity: "zhang" };
		config.identities = { zhang: { external_id: "zhang" } };
		config.agents!.assistant!.default_memory_store = {
			name: "Support memory",
			description: "Confirmed support knowledge",
		};
		const diagnostics = validateProjectConfig(config);
		expect(diagnostics.some((item) => item.code.includes("default_memory_store"))).toBe(false);
	});

	test("rejects a default memory Identity pinned to another provider", () => {
		const config = forwardConfig();
		config.defaults = { provider: "qoder", identity: "zhang" };
		config.identities = { zhang: { external_id: "zhang", provider: "claude" } };
		config.agents!.assistant!.default_memory_store = { name: "Support memory" };
		const diagnostics = validateProjectConfig(config);
		expect(
			diagnostics.some((item) => item.code === "qoder.template.default_memory_store.identity.provider_mismatch"),
		).toBe(true);
	});

	test("rejects default memory deletion for an externally managed Identity", () => {
		const config = forwardConfig();
		config.defaults = { provider: "qoder", identity: "zhang" };
		config.identities = { zhang: { identity_id: "idn_external" } };
		config.agents!.assistant!.default_memory_store = {
			name: "Support memory",
			delete_on_destroy: true,
		};
		const diagnostics = validateProjectConfig(config);
		expect(
			diagnostics.some((item) => item.code === "qoder.template.default_memory_store.delete.external_identity"),
		).toBe(true);
	});

	test("rejects Agent session resources because Forward sessions cannot attach them", () => {
		const config = forwardConfig();
		config.agents!.assistant!.resources = [
			{
				type: "github_repository",
				url: "https://github.com/acme/repo.git",
				authorization_token: "secret",
			},
		];
		const state = StateManager.initialize(tmpPath("forward-session-resources"));
		expect(() => buildSessionBindings("assistant", config, "qoder", state)).toThrow(/managed delivery/);
	});
	test("rejects forward delivery on providers without the capability", () => {
		const config = forwardConfig();
		config.providers = { bailian: {} };
		config.defaults = { provider: "bailian" };
		config.agents!.assistant!.delivery = { bailian: { type: "forward" } };
		const diagnostics = validateProjectConfig(config);
		expect(diagnostics.some((item) => item.code === "bailian.agent.delivery.forward.unsupported")).toBe(true);
	});

	test("accepts managed_tool_config on a forward-delivered Qoder agent", () => {
		const config = forwardConfig();
		config.agents!.assistant!.managed_tool_config = { enabled_tools: ["create_forward_schedule"] };
		const diagnostics = validateProjectConfig(config);
		expect(diagnostics.some((item) => item.code.includes("managed_tool_config"))).toBe(false);
	});

	test("rejects managed_tool_config on managed delivery because it is a Template field", () => {
		const config = forwardConfig();
		delete config.agents!.assistant!.delivery;
		config.agents!.assistant!.managed_tool_config = { enabled_tools: ["create_forward_schedule"] };
		const diagnostics = validateProjectConfig(config);
		expect(diagnostics.some((item) => item.code === "qoder.agent.managed_tool_config.forward_required")).toBe(true);
	});

	test("rejects managed_tool_config on providers other than Qoder", () => {
		const config = forwardConfig();
		config.providers = { bailian: {} };
		config.defaults = { provider: "bailian" };
		delete config.agents!.assistant!.delivery;
		delete config.agents!.assistant!.tunnel;
		delete config.agents!.assistant!.environment_variables;
		config.agents!.assistant!.managed_tool_config = { enabled_tools: ["create_forward_schedule"] };
		const diagnostics = validateProjectConfig(config);
		expect(diagnostics.some((item) => item.code === "bailian.agent.managed_tool_config.unsupported")).toBe(true);
	});

	test("rejects managed deployments that reference a forward template", () => {
		const config = forwardConfig();
		config.deployments = {
			job: { agent: "assistant", initial_events: [{ type: "user.message", content: "run" }] },
		};
		const diagnostics = validateProjectConfig(config);
		expect(diagnostics.some((item) => item.code === "qoder.deployment.forward_template.unsupported")).toBe(true);
	});

	test("builds Forward session bindings from the explicit YAML identity default", () => {
		const config = forwardConfig();
		config.defaults = { provider: "qoder", identity: "zhang" };
		config.identities = { zhang: { external_id: "zhang" } };
		const state = StateManager.initialize(tmpPath("forward-session"));
		state.setResource({
			address: { type: "template", name: "assistant", provider: "qoder" },
			remote_id: "tmpl_1",
			content_hash: "h",
		});
		state.setResource({
			address: { type: "identity", name: "zhang", provider: "qoder" },
			remote_id: "idn_zhang",
			content_hash: "h",
		});
		expect(buildSessionBindings("assistant", config, "qoder", state)).toMatchObject({
			delivery: "forward",
			template_id: "tmpl_1",
			identity_id: "idn_zhang",
		});
	});

	test("uses different caller Identities with the same applied Template", () => {
		const config = forwardConfig();
		config.defaults = { provider: "qoder", identity: "zhang" };
		config.identities = { zhang: { external_id: "zhang" } };
		const state = StateManager.initialize(tmpPath("forward-multi-user"));
		state.setResource({
			address: { type: "template", name: "assistant", provider: "qoder" },
			remote_id: "tmpl_shared",
			content_hash: "h",
		});
		state.setResource({
			address: { type: "identity", name: "zhang", provider: "qoder" },
			remote_id: "idn_zhang",
			content_hash: "h",
		});

		const zhang = buildSessionBindings("assistant", config, "qoder", state);
		const li = buildSessionBindings("assistant", config, "qoder", state, { identityId: "idn_li" });

		expect(zhang).toMatchObject({ template_id: "tmpl_shared", identity_id: "idn_zhang" });
		expect(li).toMatchObject({ template_id: "tmpl_shared", identity_id: "idn_li" });
	});

	test("rejects Forward sessions when no declared Identity is configured", () => {
		const config = forwardConfig();
		const state = StateManager.initialize(tmpPath("forward-missing-identity"));
		state.setResource({
			address: { type: "template", name: "assistant", provider: "qoder" },
			remote_id: "tmpl_1",
			content_hash: "h",
		});

		expect(() => buildSessionBindings("assistant", config, "qoder", state)).toThrow(/defaults.identity/);
	});
});

describe("Qoder Forward default memory store", () => {
	test("deletes a captured default Store through the Cloud permanent-delete endpoint", async () => {
		const managedCalls: string[] = [];
		const forwardCalls: string[] = [];
		const adapter = new QoderAdapter("pt-test") as any;
		adapter.client = {
			delete: async (path: string) => managedCalls.push(`DELETE ${path}`),
		};
		adapter.forwardClient = {
			get: async (path: string) => {
				forwardCalls.push(`GET ${path}`);
				return {
					data: [{ memory_store_id: "memstore_default", system_managed: true, access: "read_write" }],
				};
			},
			delete: async (path: string) => forwardCalls.push(`DELETE ${path}`),
		};

		const id = await adapter.findDefaultMemoryStoreId("idn_1", "tmpl_1");
		await adapter.deleteDefaultMemoryStore(id!);

		expect(forwardCalls).toEqual(["GET /identities/idn_1/templates/tmpl_1/memory_stores"]);
		expect(managedCalls).toEqual(["DELETE /memory_stores/memstore_default"]);
	});

	test("finds the writable system mount and updates changed metadata", async () => {
		const calls: Array<{ path: string; body?: unknown }> = [];
		const adapter = new QoderAdapter("pt-test") as any;
		adapter.forwardClient = {
			get: async (path: string) => {
				calls.push({ path });
				if (path.includes("/identities/")) {
					return {
						data: [
							{ memory_store_id: "memstore_default", system_managed: true, access: "read_write" },
							{ memory_store_id: "memstore_explicit", system_managed: false, access: "read_only" },
						],
					};
				}
				if (path === "/memory_stores/memstore_default") return { name: "System Default Memory", description: "" };
				throw new Error(`unexpected GET ${path}`);
			},
			post: async (path: string, body: unknown) => {
				calls.push({ path, body });
				return { id: "memstore_default" };
			},
		};

		const result = await adapter.reconcileDefaultMemoryStore("idn_1", "tmpl_1", {
			name: "Support memory",
			description: "Confirmed support knowledge",
		});
		expect(result).toEqual({ status: "updated", memory_store_id: "memstore_default" });
		expect(calls.at(-1)).toEqual({
			path: "/memory_stores/memstore_default",
			body: { name: "Support memory", description: "Confirmed support knowledge" },
		});
	});

	test("returns pending before the first Session creates a default Store", async () => {
		const adapter = new QoderAdapter("pt-test") as any;
		adapter.forwardClient = { get: async () => ({ data: [] }) };
		expect(await adapter.reconcileDefaultMemoryStore("idn_1", "tmpl_1", { name: "Support memory" })).toEqual({
			status: "pending",
		});
	});

	test("reconciles on an otherwise no-op apply", async () => {
		const config = forwardConfig();
		config.defaults = { provider: "qoder", identity: "zhang" };
		config.identities = { zhang: { external_id: "zhang" } };
		config.agents!.assistant!.default_memory_store = { name: "Support memory" };
		const state = StateManager.initialize(tmpPath("default-memory-no-op"));
		state.setResource({
			address: { type: "identity", name: "zhang", provider: "qoder" },
			remote_id: "idn_1",
			content_hash: "identity-hash",
		});
		state.setResource({
			address: { type: "template", name: "assistant", provider: "qoder" },
			remote_id: "tmpl_1",
			content_hash: "template-hash",
		});
		const calls: unknown[] = [];
		const provider = {
			reconcileDefaultMemoryStore: async (...args: unknown[]) => {
				calls.push(args);
				return { status: "unchanged", memory_store_id: "memstore_default" };
			},
		} as unknown as ProviderAdapter;
		await executePlan(
			{
				actions: [
					{
						action: "no-op",
						address: { type: "template", name: "assistant", provider: "qoder" },
						dependencies: [],
					},
				],
				diagnostics: [],
			},
			{ config, providers: new Map([["qoder", provider]]), state },
		);
		expect(calls).toEqual([["idn_1", "tmpl_1", { name: "Support memory" }]]);
	});

	test("does not reconcile Qoder defaults when the execution plan targets another provider", async () => {
		const config = forwardConfig();
		config.defaults = { provider: "all", identity: "zhang" };
		config.identities = { zhang: { external_id: "zhang" } };
		config.agents!.assistant!.provider = "qoder";
		config.agents!.assistant!.default_memory_store = { name: "Support memory" };
		const state = StateManager.initialize(tmpPath("provider-scope"));
		state.setResource({
			address: { type: "identity", name: "zhang", provider: "qoder" },
			remote_id: "idn_1",
			content_hash: "identity-hash",
		});
		state.setResource({
			address: { type: "template", name: "assistant", provider: "qoder" },
			remote_id: "tmpl_1",
			content_hash: "template-hash",
		});
		const calls: unknown[] = [];
		const provider = {
			reconcileDefaultMemoryStore: async (...args: unknown[]) => {
				calls.push(args);
				return { status: "unchanged" };
			},
		} as unknown as ProviderAdapter;
		await executePlan(
			{
				actions: [
					{
						action: "no-op",
						address: { type: "agent", name: "other", provider: "claude" },
						dependencies: [],
					},
				],
				diagnostics: [],
			},
			{ config, providers: new Map([["qoder", provider]]), state },
		);
		expect(calls).toEqual([]);
	});

	test("reconciles when Qoder is the sole provider and no provider default is declared", async () => {
		const config = forwardConfig();
		config.defaults = { identity: "zhang" };
		config.identities = { zhang: { external_id: "zhang" } };
		config.agents!.assistant!.default_memory_store = { name: "Support memory" };
		const state = StateManager.initialize(tmpPath("implicit-qoder"));
		state.setResource({
			address: { type: "identity", name: "zhang", provider: "qoder" },
			remote_id: "idn_1",
			content_hash: "identity-hash",
		});
		state.setResource({
			address: { type: "template", name: "assistant", provider: "qoder" },
			remote_id: "tmpl_1",
			content_hash: "template-hash",
		});
		const calls: unknown[] = [];
		const provider = {
			reconcileDefaultMemoryStore: async (...args: unknown[]) => {
				calls.push(args);
				return { status: "unchanged" };
			},
		} as unknown as ProviderAdapter;
		await executePlan(
			{
				actions: [
					{
						action: "no-op",
						address: { type: "template", name: "assistant", provider: "qoder" },
						dependencies: [],
					},
				],
				diagnostics: [],
			},
			{ config, providers: new Map([["qoder", provider]]), state },
		);
		expect(calls).toEqual([["idn_1", "tmpl_1", { name: "Support memory" }]]);
	});
});
