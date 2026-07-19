import { describe, expect, test } from "bun:test";
import { validateProjectConfig } from "../../src/internal/core/validate-config.ts";
import type { ExecContext } from "../../src/internal/executor/context.ts";
import { executePlan } from "../../src/internal/executor/executor.ts";
import { computeResourceHash } from "../../src/internal/planner/hasher.ts";
import { buildPlan } from "../../src/internal/planner/planner.ts";
import type { ProviderAdapter } from "../../src/internal/providers/interface.ts";
import { StateManager } from "../../src/internal/state/state-manager.ts";
import type { ProjectConfig } from "../../src/internal/types/config.ts";
import type { ExecutionPlan } from "../../src/internal/types/plan.ts";
import type { ResourceAddress, StateFile } from "../../src/internal/types/state.ts";
import { addressKey } from "../../src/internal/types/state.ts";
import "../../src/internal/providers/all.ts";

const emptyState: StateFile = { resources: [] };

function byocConfig(): ProjectConfig {
	return {
		version: "1",
		providers: { qoder: { api_key: "test" } },
		defaults: { provider: "qoder" },
		environments: {
			byoc: { environment_id: "env_byoc_1", config: { type: "self_hosted" } },
		},
		tunnels: {
			internal: { tunnel_id: "tnl_1" },
		},
		agents: {
			assistant: {
				model: "qmodel_latest",
				instructions: "run",
				environment: "byoc",
				tunnel: "internal",
			},
		},
		deployments: {
			daily: { agent: "assistant" },
		},
	};
}

function managedByocConfig(): ProjectConfig {
	// Same environment block but WITHOUT `environment_id` — i.e. the user deleted
	// the one line that marks it as an external reference.
	const config = byocConfig();
	config.environments = { byoc: { config: { type: "self_hosted" } } };
	return config;
}

function markedEnvState(): StateFile {
	return {
		resources: [
			{
				address: { type: "environment", name: "byoc", provider: "qoder" },
				remote_id: "env_byoc_1",
				externally_managed: true,
				content_hash: "h_old",
			},
		],
	};
}

describe("planner environment ownership", () => {
	test("blocks converting an external environment back to managed", async () => {
		const plan = await buildPlan(managedByocConfig(), markedEnvState());

		const errors = plan.diagnostics.filter((d) => d.severity === "error");
		expect(errors.some((d) => d.code === "plan.environment.ownership_transition")).toBe(true);
		expect(errors[0]?.message).toMatch(/agents state rm/);
		// No update action may be generated for the environment at all.
		expect(plan.actions.some((a) => a.address.type === "environment")).toBe(false);
	});

	test("still allows the reference to be released by removing the whole block", async () => {
		const config = managedByocConfig();
		config.environments = undefined;
		config.agents = undefined;
		config.deployments = undefined;

		const plan = await buildPlan(config, markedEnvState());

		expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
		const del = plan.actions.find((a) => a.action === "delete");
		expect(del?.address.type).toBe("environment");
		expect(del?.reason).toMatch(/left intact/);
	});

	test("warns when switching a managed environment to a different external id", async () => {
		const state: StateFile = {
			resources: [
				{
					address: { type: "environment", name: "byoc", provider: "qoder" },
					remote_id: "env_old_managed",
					content_hash: "h_old",
				},
			],
		};

		const plan = await buildPlan(byocConfig(), state);

		const warnings = plan.diagnostics.filter((d) => d.severity === "warning");
		const orphan = warnings.find((d) => d.code === "plan.environment.ownership_orphan");
		expect(orphan).toBeDefined();
		expect(orphan?.message).toContain("env_old_managed");
		// The reference switch itself is allowed: an update records the new id.
		expect(plan.actions.some((a) => a.action === "update" && a.address.type === "environment")).toBe(true);
	});

	test("labels external environment create as reference-only", async () => {
		const plan = await buildPlan(byocConfig(), emptyState);
		const create = plan.actions.find((a) => a.action === "create" && a.address.type === "environment");
		expect(create?.reason).toMatch(/no remote mutation/);
	});

	test("deployment does NOT update when only the tunnel id value changes", async () => {
		// Qoder's deployment API rejects tunnel_id, so the value never reaches the
		// wire; changing it must not churn no-op deployment updates.
		const config = byocConfig();
		const plan1 = await buildPlan(config, emptyState);
		const creates = plan1.actions.filter((a) => a.action === "create");

		const state: StateFile = {
			resources: creates.map((a) => ({
				address: a.address,
				remote_id: `fake_${a.address.name}`,
				content_hash: "",
			})),
		};
		const lookup = {
			getResource: (addr: ResourceAddress) => state.resources.find((r) => addressKey(r.address) === addressKey(addr)),
		};
		for (const res of state.resources) {
			res.content_hash = await computeResourceHash(res.address, config, undefined, lookup);
		}

		const changed = byocConfig();
		changed.tunnels = { internal: { tunnel_id: "tnl_2" } };
		const plan2 = await buildPlan(changed, state);

		expect(plan2.actions.filter((a) => a.action !== "no-op")).toEqual([]);
	});

	test("deployment updates when the external environment id value changes", async () => {
		const config = byocConfig();
		const plan1 = await buildPlan(config, emptyState);
		const creates = plan1.actions.filter((a) => a.action === "create");

		const state: StateFile = {
			resources: creates.map((a) => ({
				address: a.address,
				remote_id: `fake_${a.address.name}`,
				content_hash: "",
			})),
		};
		const lookup = {
			getResource: (addr: ResourceAddress) => state.resources.find((r) => addressKey(r.address) === addressKey(addr)),
		};
		for (const res of state.resources) {
			res.content_hash = await computeResourceHash(res.address, config, undefined, lookup);
		}

		const changed = byocConfig();
		changed.environments = { byoc: { environment_id: "env_byoc_2", config: { type: "self_hosted" } } };
		const plan2 = await buildPlan(changed, state);

		const updatedTypes = plan2.actions
			.filter((a) => a.action === "update")
			.map((a) => a.address.type)
			.sort();
		// Environment re-records the reference; deployment is rebound to the new id.
		expect(updatedTypes).toEqual(["deployment", "environment"]);
	});
});

describe("executor environment ownership defense", () => {
	test("refuses to update a marked environment when config dropped environment_id", async () => {
		const calls: string[] = [];
		const provider = {
			name: "qoder",
			validate: async () => {},
			findResource: async () => null,
			updateEnvironment: async () => {
				calls.push("updateEnvironment");
				return { id: "env_byoc_1", type: "environment" };
			},
			deleteEnvironment: async () => {
				calls.push("deleteEnvironment");
			},
		} as unknown as ProviderAdapter;

		const address = { type: "environment" as const, name: "byoc", provider: "qoder" };
		const plan: ExecutionPlan = {
			actions: [
				{
					action: "update",
					address,
					reason: "Local config changed",
					before: { content_hash: "h_old" },
					after: { content_hash: "h_new" },
					dependencies: [],
				},
			],
			diagnostics: [],
		};

		const state = StateManager.initialize("/tmp/byoc-ownership-exec.json");
		state.setResource({ address, remote_id: "env_byoc_1", externally_managed: true, content_hash: "h_old" });

		const ctx: ExecContext = {
			config: managedByocConfig(),
			configPath: "/tmp/agents.yaml",
			providers: new Map([["qoder", provider]]),
			state,
		};

		const result = await executePlan(plan, ctx);

		expect(calls).toEqual([]);
		expect(result.results[0]?.status).toBe("failed");
		expect(result.results[0]?.error?.message).toMatch(/external reference/);
		// The marker must survive the refused apply.
		expect(state.getResource(address)?.externally_managed).toBe(true);
	});
});

describe("validate self_hosted capability", () => {
	test("errors for a managed self_hosted environment on a non-qoder provider", () => {
		const config: ProjectConfig = {
			version: "1",
			providers: { bailian: { api_key: "test", workspace_id: "ws" } },
			defaults: { provider: "bailian" },
			environments: {
				wrong: { config: { type: "self_hosted" } },
			},
		};

		const diagnostics = validateProjectConfig(config);
		expect(diagnostics.some((d) => d.code === "bailian.environment.self_hosted.unsupported")).toBe(true);
	});

	test("warns that qoder deployments cannot carry a tunnel", () => {
		const diagnostics = validateProjectConfig(byocConfig());
		const warning = diagnostics.find((d) => d.code === "qoder.deployment.tunnel.unsupported");
		expect(warning?.severity).toBe("warning");
		expect(warning?.message).toMatch(/does not accept tunnel_id/);
	});

	test("ignores self_hosted on external references and on qoder", () => {
		const external: ProjectConfig = {
			version: "1",
			providers: { bailian: { api_key: "test", workspace_id: "ws" } },
			defaults: { provider: "bailian" },
			environments: {
				ref: { environment_id: "env_x", config: { type: "self_hosted" } },
			},
		};
		expect(validateProjectConfig(external).filter((d) => d.code.includes("self_hosted"))).toEqual([]);

		const qoder = byocConfig();
		expect(validateProjectConfig(qoder).filter((d) => d.code.includes("self_hosted"))).toEqual([]);
	});
});
