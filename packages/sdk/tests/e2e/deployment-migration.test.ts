import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectRuntimeContext } from "../../src/internal/core/project-runtime.ts";
import { executePlannedProject, planProjectContext } from "../../src/internal/core/resource-runtime.ts";
import { computeResourceHash } from "../../src/internal/planner/hasher.ts";
import { BailianAdapter } from "../../src/internal/providers/bailian/adapter.ts";
import "../../src/internal/providers/ark/index.ts";
import "../../src/internal/providers/bailian/index.ts";
import { StateManager } from "../../src/internal/state/state-manager.ts";
import type { ResolvedProjectConfig } from "../../src/internal/types/config.ts";
import type { ResourceAddress } from "../../src/internal/types/state.ts";

function statePath(provider: string): string {
	return join(tmpdir(), `deployment-migration-${provider}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

function configFor(provider: "ark" | "bailian"): ResolvedProjectConfig {
	return {
		version: "1",
		providers:
			provider === "bailian" ? { bailian: { api_key: "test", workspace_id: "ws" } } : { ark: { api_key: "test" } },
		defaults: { provider },
		environments: {
			dev: { config: { type: "cloud" } },
		},
		agents: {
			helper: {
				model: "qwen3",
				instructions: "Help with the task.",
				environment: "dev",
			},
		},
		deployments: {
			daily: {
				agent: "helper",
				initial_events: [{ type: "user.message", content: "Run the task." }],
			},
		},
		_resolved: true,
	};
}

async function legacyState(config: ResolvedProjectConfig, provider: "ark" | "bailian"): Promise<StateManager> {
	const state = StateManager.initialize(statePath(provider));
	const environment: ResourceAddress = { type: "environment", name: "dev", provider };
	state.setResource({
		address: environment,
		remote_id: "env_1",
		content_hash: await computeResourceHash(environment, config, "/tmp/agents.yaml", state),
	});

	const agent: ResourceAddress = { type: "agent", name: "helper", provider };
	state.setResource({
		address: agent,
		remote_id: "agent_1",
		content_hash: await computeResourceHash(agent, config, "/tmp/agents.yaml", state),
	});

	const deployment: ResourceAddress = { type: "deployment", name: "daily", provider };
	state.setResource({
		address: deployment,
		remote_id: null,
		content_hash: await computeResourceHash(deployment, config, "/tmp/agents.yaml", state),
	});
	return state;
}

describe("legacy emulated deployment migration", () => {
	test("materializes a native Bailian deployment and converges on the next plan", async () => {
		const config = configFor("bailian");
		const state = await legacyState(config, "bailian");
		const calls: Array<{ path: string; body: unknown }> = [];
		let updateCalls = 0;
		const adapter = new BailianAdapter("test", "ws", undefined, "migration-test");
		(adapter as unknown as { client: { post: (path: string, body: unknown) => Promise<unknown> } }).client = {
			async post(path, body) {
				calls.push({ path, body });
				return { id: "depl_native_1", type: "deployment" };
			},
		};
		adapter.updateDeployment = async () => {
			updateCalls += 1;
			throw new Error("A deployment without a remote id must be created, not updated");
		};
		const runtime: ProjectRuntimeContext = {
			configPath: "/tmp/agents.yaml",
			projectName: "migration-test",
			config,
			state,
			providers: new Map([["bailian", adapter]]),
		};

		const firstPlan = await planProjectContext(runtime, { refresh: false });
		const migration = firstPlan.plan.actions.find((action) => action.address.type === "deployment");
		expect(migration?.action).toBe("update");
		expect(migration?.reason).toContain("native deployment");

		const execution = await executePlannedProject(firstPlan);
		expect(execution.partial).toBe(false);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.path).toBe("/deployments");
		expect(updateCalls).toBe(0);
		expect(state.getResource({ type: "deployment", name: "daily", provider: "bailian" })?.remote_id).toBe(
			"depl_native_1",
		);

		const secondPlan = await planProjectContext(runtime, { refresh: false });
		const converged = secondPlan.plan.actions.find((action) => action.address.type === "deployment");
		expect(converged?.action).toBe("no-op");
	});

	test("keeps an emulated Ark deployment with a null remote id as no-op", async () => {
		const config = configFor("ark");
		const state = await legacyState(config, "ark");
		const runtime: ProjectRuntimeContext = {
			configPath: "/tmp/agents.yaml",
			projectName: "migration-test",
			config,
			state,
			providers: new Map(),
		};

		const plan = await planProjectContext(runtime, { refresh: false });
		const deployment = plan.plan.actions.find((action) => action.address.type === "deployment");
		expect(deployment?.action).toBe("no-op");
	});
});
