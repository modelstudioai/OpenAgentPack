import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateProjectConfig } from "../../src/internal/core/validate-config.ts";
import { executePlan } from "../../src/internal/executor/executor.ts";
import { buildDependencyGraph } from "../../src/internal/graph/dependency.ts";
import { computeResourceHash } from "../../src/internal/planner/hasher.ts";
import { buildPlan } from "../../src/internal/planner/planner.ts";
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
				delivery: { qoder: { type: "forward" } },
			},
		},
	};
}

describe("Qoder Forward Template declaration", () => {
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
});

describe("Qoder Forward Template mapping and lifecycle", () => {
	test("maps BYOC bindings and tool permissions", () => {
		const decl = forwardConfig().agents!.assistant!;
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
		});
		expect(body.tools[0].configs).toEqual([
			{
				name: "Bash",
				enabled: true,
				permission_policy: { type: "always_ask" },
			},
			{ name: "Read", enabled: true },
		]);
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
			"POST /resources/registry",
			"POST /templates",
			"POST /resources/registry",
			"POST /templates/tmpl_1",
			"POST /templates/tmpl_1/archive",
			"GET /templates/tmpl_1",
		]);
		expect(calls.filter((call) => call.path === "/resources/registry").map((call) => call.body)).toEqual([
			{ type: "vault", resource: { id: "vault_mcp" } },
			{ type: "vault", resource: { id: "vault_mcp" } },
		]);
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

	test("resolves Qoder's system Identity external_id to its real id and caches it", async () => {
		const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
		const adapter = new QoderAdapter("pt-test") as any;
		adapter.forwardClient = {
			get: async (path: string) => {
				calls.push({ method: "GET", path });
				if (path === "/identities?limit=100") {
					return {
						data: [{ id: "idn_other", external_id: "other" }],
						has_more: true,
						last_id: "idn_other",
					};
				}
				if (path === "/identities?limit=100&after_id=idn_other") {
					return {
						data: [{ id: "idn_admin", external_id: "__qca_admin_identity__", enabled: true }],
						has_more: false,
					};
				}
				throw new Error(`unexpected GET ${path}`);
			},
			post: async (path: string, body: Record<string, unknown>) => {
				expect(path).toBe("/sessions");
				calls.push({ method: "POST", path, body });
				return {
					id: `sess_default_identity_${calls.length}`,
					status: "idle",
					template: { id: "tmpl_1" },
					identity_id: "idn_admin",
					created_at: "2026-01-01T00:00:00Z",
				};
			},
		};

		await adapter.createSession({ delivery: "forward", template_id: "tmpl_1" });
		await adapter.createSession({ delivery: "forward", template_id: "tmpl_1" });

		expect(calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
			"GET /identities?limit=100",
			"GET /identities?limit=100&after_id=idn_other",
			"POST /sessions",
			"POST /sessions",
		]);
		expect(calls.filter((call) => call.method === "POST").map((call) => call.body?.identity_id)).toEqual([
			"idn_admin",
			"idn_admin",
		]);
	});

	test("fails clearly when Qoder's system Identity is not provisioned", async () => {
		const adapter = new QoderAdapter("pt-test") as any;
		adapter.forwardClient = {
			get: async () => ({ data: [], has_more: false }),
			post: async () => {
				throw new Error("session must not be created");
			},
		};

		await expect(adapter.createSession({ delivery: "forward", template_id: "tmpl_1" })).rejects.toThrow(
			/__qca_admin_identity__.*--identity-id/,
		);
	});
});

describe("Forward delivery validation and runtime isolation", () => {
	test("rejects forward delivery on providers without the capability", () => {
		const config = forwardConfig();
		config.providers = { bailian: {} };
		config.defaults = { provider: "bailian" };
		config.agents!.assistant!.delivery = { bailian: { type: "forward" } };
		const diagnostics = validateProjectConfig(config);
		expect(diagnostics.some((item) => item.code === "bailian.agent.delivery.forward.unsupported")).toBe(true);
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
		config.defaults = {
			provider: "qoder",
			session: { qoder: { identity_id: "idn_zhang" } },
		} as ProjectConfig["defaults"];
		const state = StateManager.initialize(tmpPath("forward-session"));
		state.setResource({
			address: { type: "template", name: "assistant", provider: "qoder" },
			remote_id: "tmpl_1",
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
		config.defaults = {
			provider: "qoder",
			session: { qoder: { identity_id: "idn_zhang" } },
		};
		const state = StateManager.initialize(tmpPath("forward-multi-user"));
		state.setResource({
			address: { type: "template", name: "assistant", provider: "qoder" },
			remote_id: "tmpl_shared",
			content_hash: "h",
		});

		const zhang = buildSessionBindings("assistant", config, "qoder", state);
		const li = buildSessionBindings("assistant", config, "qoder", state, { identityId: "idn_li" });

		expect(zhang).toMatchObject({ template_id: "tmpl_shared", identity_id: "idn_zhang" });
		expect(li).toMatchObject({ template_id: "tmpl_shared", identity_id: "idn_li" });
	});

	test("allows Qoder to use its default Identity when none is configured", () => {
		const config = forwardConfig();
		const state = StateManager.initialize(tmpPath("forward-missing-identity"));
		state.setResource({
			address: { type: "template", name: "assistant", provider: "qoder" },
			remote_id: "tmpl_1",
			content_hash: "h",
		});

		expect(buildSessionBindings("assistant", config, "qoder", state)).toEqual({
			delivery: "forward",
			template_id: "tmpl_1",
			files: [],
			title: undefined,
			metadata: undefined,
		});
	});
});
