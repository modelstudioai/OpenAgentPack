import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executePlan } from "../../src/internal/executor/executor.ts";
import { buildDependencyGraph } from "../../src/internal/graph/dependency.ts";
import { buildPlan } from "../../src/internal/planner/planner.ts";
import type { ProviderAdapter } from "../../src/internal/providers/interface.ts";
import { QoderAdapter } from "../../src/internal/providers/qoder/adapter.ts";
import { StateManager } from "../../src/internal/state/state-manager.ts";
import type { ProjectConfig } from "../../src/internal/types/config.ts";
import "../../src/internal/providers/all.ts";

function config(): ProjectConfig {
	return {
		version: "1",
		providers: { qoder: { api_key: "test" } },
		defaults: { provider: "qoder", identity: "chen" },
		identities: {
			chen: {
				external_id: "user_456",
				name: "Chen",
				metadata: { team: "engineering" },
			},
		},
		environments: {
			byoc: { environment_id: "env_byoc", config: { type: "self_hosted" } },
		},
		agents: {
			assistant: {
				model: { qoder: "auto" },
				instructions: "Help the user.",
				environment: "byoc",
				delivery: { qoder: { type: "forward" } },
			},
		},
		channels: {
			dingtalk: {
				agent: "assistant",
				type: "dingtalk",
				credentials: { client_id: "client", client_secret: "secret" },
			},
		},
	};
}

describe("Identity and Channel declarations", () => {
	test("plans Identity and Template before Channel", async () => {
		const desired = config();
		const graph = buildDependencyGraph(desired, ["qoder"]);
		expect([...graph.edges.get("qoder.channel.dingtalk")!].sort()).toEqual([
			"qoder.identity.chen",
			"qoder.template.assistant",
		]);

		const plan = await buildPlan(desired, { resources: [] });
		expect(plan.diagnostics).toEqual([]);
		const actions = plan.actions.map((action) => `${action.address.type}.${action.address.name}`);
		expect(actions.indexOf("identity.chen")).toBeLessThan(actions.indexOf("channel.dingtalk"));
		expect(actions.indexOf("template.assistant")).toBeLessThan(actions.indexOf("channel.dingtalk"));
	});

	test("keeps unsupported Provider capabilities isolated", async () => {
		const desired = config();
		desired.providers = { claude: {} };
		desired.defaults = { provider: "claude", identity: "chen" };
		const plan = await buildPlan(desired, { resources: [] });
		expect(plan.diagnostics.some((item) => item.code === "claude.identity.unsupported")).toBe(true);
		expect(plan.diagnostics.some((item) => item.code === "claude.channel.unsupported")).toBe(true);
		expect(plan.actions.some((item) => item.address.type === "identity" || item.address.type === "channel")).toBe(
			false,
		);
	});

	test("records an external Identity reference without mutating or deleting it", async () => {
		const desired: ProjectConfig = {
			version: "1",
			providers: { qoder: {} },
			defaults: { provider: "qoder", identity: "chen" },
			identities: { chen: { identity_id: "idn_external" } },
		};
		const calls: string[] = [];
		const provider = {
			name: "qoder",
			findResource: async () => ({ id: "idn_external", type: "identity" }),
			createIdentity: async () => {
				calls.push("create");
				return { id: "unexpected", type: "identity" };
			},
			updateIdentity: async () => {
				calls.push("update");
				return { id: "unexpected", type: "identity" };
			},
			deleteIdentity: async () => calls.push("delete"),
		} as unknown as ProviderAdapter;
		const state = StateManager.initialize(join(tmpdir(), `identity-ref-${crypto.randomUUID()}.json`));
		const ctx = {
			config: desired,
			configPath: "/tmp/agents.yaml",
			providers: new Map([["qoder", provider]]),
			state,
		};

		const createPlan = await buildPlan(desired, state.getStateFile());
		await executePlan(createPlan, ctx);
		expect(state.getResource({ type: "identity", name: "chen", provider: "qoder" })).toMatchObject({
			remote_id: "idn_external",
			externally_managed: true,
		});

		ctx.config = { ...desired, defaults: { provider: "qoder" }, identities: undefined };
		const deletePlan = await buildPlan(ctx.config, state.getStateFile());
		await executePlan(deletePlan, ctx);
		expect(calls).toEqual([]);
	});
});

describe("Qoder Identity and Channel adapter", () => {
	test("maps managed Identity lifecycle to Forward endpoints", async () => {
		const calls: Array<{ method: string; path: string; body?: unknown }> = [];
		const adapter = new QoderAdapter("pt-test") as any;
		adapter.forwardClient = {
			get: async (path: string) => {
				calls.push({ method: "GET", path });
				return { id: "idn_1", metadata: { old: "value" } };
			},
			post: async (path: string, body: unknown) => {
				calls.push({ method: "POST", path, body });
				return { id: "idn_1", type: "identity" };
			},
			delete: async (path: string) => calls.push({ method: "DELETE", path }),
		};

		const decl = { external_id: "user_456", name: "Chen", metadata: { team: "engineering" } } as const;
		await adapter.createIdentity("chen", decl);
		await adapter.updateIdentity("idn_1", "chen", decl);
		await adapter.deleteIdentity("idn_1");

		expect(calls[0]).toMatchObject({
			method: "POST",
			path: "/identities",
			body: { external_id: "user_456", name: "Chen", enabled: true, metadata: { team: "engineering" } },
		});
		expect(calls[2]).toMatchObject({
			method: "POST",
			path: "/identities/idn_1",
			body: { metadata: { team: "engineering", old: "" } },
		});
		expect(calls.at(-1)).toEqual({ method: "DELETE", path: "/identities/idn_1" });
	});

	test("maps logical references and generic Channel fields to Qoder wire fields", async () => {
		const calls: Array<{ method: string; path: string; body?: any }> = [];
		const adapter = new QoderAdapter("pt-test") as any;
		adapter.forwardClient = {
			post: async (path: string, body: unknown) => {
				calls.push({ method: "POST", path, body });
				return { id: "channel_1", type: "channel" };
			},
			delete: async (path: string) => calls.push({ method: "DELETE", path }),
		};

		await adapter.createChannel(
			"dingtalk",
			{
				agent: "assistant",
				type: "dingtalk",
				credentials: { client_id: "client", client_secret: "secret" },
				options: { include_thinking: true },
			},
			{ identity_id: "idn_1", agent_id: "tmpl_1" },
		);

		expect(calls[0]).toMatchObject({
			method: "POST",
			path: "/channels",
			body: {
				identity_id: "idn_1",
				template_id: "tmpl_1",
				channel_type: "dingtalk",
				name: "dingtalk",
				enabled: true,
				channel_config: {
					credentials: { client_id: "client", client_secret: "secret" },
					response_options: { include_tool_calls: false, include_thinking: true },
				},
			},
		});
	});
});
