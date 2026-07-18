import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { resolveDeploymentRefs } from "../../src/internal/executor/resolver.ts";
import { loadConfig } from "../../src/internal/parser/index.ts";
import { buildPlan } from "../../src/internal/planner/planner.ts";
import type { ResolvedDeploymentRefs } from "../../src/internal/providers/interface.ts";
import { QoderAdapter } from "../../src/internal/providers/qoder/adapter.ts";
import { StateManager } from "../../src/internal/state/state-manager.ts";
import type { DeploymentDecl, ProjectConfig } from "../../src/internal/types/config.ts";
import type { StateFile } from "../../src/internal/types/state.ts";
import "../../src/internal/providers/claude/index.ts";
import "../../src/internal/providers/qoder/index.ts";

const FIXTURES = resolve(import.meta.dir, "../fixtures");

function makeConfig(): ProjectConfig {
	return {
		version: "1",
		providers: { qoder: {} },
		environments: {
			dev: { config: { type: "cloud" } },
			prod: { config: { type: "cloud" } },
		},
		vaults: { secrets: { display_name: "Secrets", credentials: [] } },
		memory_stores: { notes: { description: "shared notes" } },
		agents: {
			researcher: {
				model: "ultimate",
				instructions: "do research",
				environment: "dev",
				vault: "secrets",
				memory_stores: ["notes"],
			},
		},
		deployments: {
			daily: {
				agent: "researcher",
				schedule: { expression: "0 9 * * *", timezone: "UTC" },
				initial_events: [{ type: "user.message", content: "run" }],
			},
			weekly: {
				agent: "researcher",
				environment: "prod",
				initial_events: [{ type: "user.message", content: "run" }],
			},
		},
	};
}

function makeState(): StateManager {
	const s = StateManager.initialize("/tmp/dep-test-state.json");
	s.setResource({
		address: { type: "environment", name: "dev", provider: "qoder" },
		remote_id: "env_1",
		content_hash: "h",
	});
	s.setResource({
		address: { type: "environment", name: "prod", provider: "qoder" },
		remote_id: "prod_1",
		content_hash: "h",
	});
	s.setResource({
		address: { type: "agent", name: "researcher", provider: "qoder" },
		remote_id: "agent_1",
		version: 2,
		content_hash: "h",
	});
	s.setResource({
		address: { type: "vault", name: "secrets", provider: "qoder" },
		remote_id: "vault_1",
		content_hash: "h",
	});
	s.setResource({
		address: { type: "memory_store", name: "notes", provider: "qoder" },
		remote_id: "ms_1",
		content_hash: "h",
	});
	return s;
}

describe("resolveDeploymentRefs", () => {
	test("inherits agent's environment, vault, and memory stores", () => {
		const refs = resolveDeploymentRefs("daily", makeConfig(), "qoder", makeState());
		expect(refs.agent_id).toBe("agent_1");
		expect(refs.environment_id).toBe("env_1");
		expect(refs.vault_ids).toEqual(["vault_1"]);
		expect(refs.memory_store_ids).toEqual({ notes: "ms_1" });
		expect(refs.agent_version).toBeUndefined();
	});

	test("deployment-level environment overrides the agent's", () => {
		const refs = resolveDeploymentRefs("weekly", makeConfig(), "qoder", makeState());
		expect(refs.environment_id).toBe("prod_1");
	});

	test("throws when a referenced resource is missing from state", () => {
		const s = StateManager.initialize("/tmp/dep-test-empty.json");
		s.setResource({
			address: { type: "environment", name: "dev", provider: "qoder" },
			remote_id: "env_1",
			content_hash: "h",
		});
		expect(() => resolveDeploymentRefs("daily", makeConfig(), "qoder", s)).toThrow(/not found in state/);
	});

	test("throws when the deployment references an unknown agent", () => {
		const config: ProjectConfig = {
			version: "1",
			providers: { qoder: {} },
			agents: {},
			deployments: { broken: { agent: "ghost", initial_events: [{ type: "user.message", content: "x" }] } },
		};
		expect(() => resolveDeploymentRefs("broken", config, "qoder", makeState())).toThrow(/references unknown agent/);
	});
});

describe("Qoder native deployment CRUD", () => {
	function makeAdapter() {
		const calls: Array<{ method: string; path: string; body?: unknown }> = [];
		const adapter = new QoderAdapter("pt-test-dummy", undefined, "proj") as QoderAdapter & {
			client: {
				post: (path: string, body: unknown) => Promise<Record<string, unknown>>;
				get: (path: string) => Promise<Record<string, unknown>>;
			};
		};
		adapter.client = {
			async post(path, body) {
				calls.push({ method: "post", path, body });
				if (path.endsWith("/run")) return { id: "drun_1", type: "deployment_run", session_id: "sess_1", error: null };
				return { id: "dep_1", type: "deployment", status: "active" };
			},
			async get(path) {
				calls.push({ method: "get", path });
				return { id: "dep_1", type: "deployment", status: "active", schedule: null };
			},
		};
		return { adapter, calls };
	}

	const decl: DeploymentDecl = { agent: "x", initial_events: [{ type: "user.message", content: "run" }] };
	const refs: ResolvedDeploymentRefs = {
		agent_id: "agent_1",
		environment_id: "env_1",
		vault_ids: [],
		memory_store_ids: {},
	};

	test("createDeployment calls the native deployments endpoint", async () => {
		const { adapter, calls } = makeAdapter();
		const res = await adapter.createDeployment("d", decl, refs, "/tmp/agents.yaml");
		expect(res).toEqual({ id: "dep_1", type: "deployment" });
		expect(calls[0]).toMatchObject({ method: "post", path: "/deployments" });
		expect(calls[0].body).toMatchObject({ name: "d", agent: "agent_1", environment_id: "env_1" });
	});

	test("updateDeployment posts a merge update to the remote deployment", async () => {
		const { adapter, calls } = makeAdapter();
		const res = await adapter.updateDeployment("dep_1", "d", decl, refs, "/tmp/agents.yaml");
		expect(res).toEqual({ id: "dep_1", type: "deployment" });
		expect(calls[0]).toMatchObject({ method: "post", path: "/deployments/dep_1" });
	});

	test("deleteDeployment archives the remote deployment", async () => {
		const { adapter, calls } = makeAdapter();
		await adapter.deleteDeployment("dep_1");
		expect(calls[0]).toMatchObject({ method: "post", path: "/deployments/dep_1/archive" });
	});

	test("runDeployment triggers a native deployment run", async () => {
		const { adapter, calls } = makeAdapter();
		const result = await adapter.runDeployment({ name: "d", id: "dep_1", decl, refs, basePath: "/tmp/agents.yaml" });
		expect(result).toEqual({ run_id: "drun_1", session_id: "sess_1", error: undefined });
		expect(calls[0]).toMatchObject({ method: "post", path: "/deployments/dep_1/run" });
	});
});

describe("deployment plan / diff", () => {
	test("plans a deployment create for every target provider from empty state", async () => {
		const { config } = await loadConfig(resolve(FIXTURES, "deployment.yaml"));
		const plan = await buildPlan(config, { resources: [] });

		const depCreates = plan.actions.filter((a) => a.action === "create" && a.address.type === "deployment");
		expect(depCreates.length).toBe(2);
		const providers = depCreates.map((a) => a.address.provider).sort();
		expect(providers).toEqual(["claude", "qoder"]);
	});

	test("a deployment depends on its agent and is ordered after it", async () => {
		const { config } = await loadConfig(resolve(FIXTURES, "deployment.yaml"));
		const plan = await buildPlan(config, { resources: [] });

		const claudeDep = plan.actions.find((a) => a.address.type === "deployment" && a.address.provider === "claude")!;
		expect(claudeDep.dependencies.some((d) => d.type === "agent")).toBe(true);

		const idxAgent = plan.actions.findIndex((a) => a.address.type === "agent" && a.address.provider === "claude");
		const idxDep = plan.actions.findIndex((a) => a.address.type === "deployment" && a.address.provider === "claude");
		expect(idxAgent).toBeLessThan(idxDep);
	});

	test("native deployment providers do not warn about emulated sub-features", async () => {
		const { config } = await loadConfig(resolve(FIXTURES, "deployment.yaml"));
		const plan = await buildPlan(config, { resources: [] });

		const codes = plan.diagnostics.filter((d) => d.severity === "warning").map((d) => d.code);

		expect(codes.some((c) => c.startsWith("qoder.deployment."))).toBe(false);
		expect(codes.some((c) => c.startsWith("claude.deployment."))).toBe(false);
	});

	test("produces no-op when state hashes match", async () => {
		const { config } = await loadConfig(resolve(FIXTURES, "deployment.yaml"));
		const plan1 = await buildPlan(config, { resources: [] });
		const creates = plan1.actions.filter((a) => a.action === "create");

		const state: StateFile = {
			resources: creates.map((a) => ({
				address: a.address,
				remote_id: `fake_${a.address.name}_${a.address.provider}`,
				content_hash: (a.after as { content_hash?: string })?.content_hash ?? "",
			})),
		};

		const plan2 = await buildPlan(config, state);
		expect(plan2.actions.filter((a) => a.action !== "no-op").length).toBe(0);
	});
});
