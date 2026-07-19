import { describe, expect, test } from "bun:test";
import type { ProjectRuntimeContext } from "../../src/internal/core/project-runtime.ts";
import { importResource } from "../../src/internal/core/resource-runtime.ts";
import type { ProviderAdapter } from "../../src/internal/providers/interface.ts";
import { StateManager } from "../../src/internal/state/state-manager.ts";
import type { ProjectConfig } from "../../src/internal/types/config.ts";
import type { ResourceAddress } from "../../src/internal/types/state.ts";
import "../../src/internal/providers/all.ts";

function config(): ProjectConfig {
	return {
		version: "1",
		providers: { bailian: { api_key: "test", workspace_id: "ws" } },
		defaults: { provider: "bailian" },
		environments: { "bailian-cli": { config: { type: "cloud" } } },
		agents: {
			"bailian-cli": {
				model: "qwen3",
				instructions: "run",
				environment: "bailian-cli",
			},
		},
	};
}

function ctx(state: StateManager): ProjectRuntimeContext {
	return {
		configPath: "/tmp/agents.yaml",
		statePath: "/tmp/import-resource.state.json",
		projectName: "test",
		config: { ...config(), _resolved: true },
		state,
		providers: new Map(),
	};
}

describe("importResource", () => {
	test("records a declared resource with the plan-derived content hash", async () => {
		const state = StateManager.initialize("/tmp/import-resource-declared.json");
		const address: ResourceAddress = { type: "environment", name: "bailian-cli", provider: "bailian" };

		const recorded = await importResource(ctx(state), address, "env_remote_1");

		expect(recorded.remote_id).toBe("env_remote_1");
		expect(recorded.content_hash).toBeTruthy();
		expect(recorded.desired_hash).toBe(recorded.content_hash);
		expect(state.getResource(address)?.remote_id).toBe("env_remote_1");
	});

	test("rejects an undeclared resource and writes no state", async () => {
		const state = StateManager.initialize("/tmp/import-resource-undeclared.json");
		const address: ResourceAddress = { type: "environment", name: "ghost", provider: "bailian" };

		await expect(importResource(ctx(state), address, "env_ghost")).rejects.toThrow(/not declared/);
		expect(state.listResources()).toEqual([]);
	});

	test("rejects a non-importable resource type", async () => {
		const state = StateManager.initialize("/tmp/import-resource-bad-type.json");
		const address: ResourceAddress = { type: "deployment", name: "bailian-cli", provider: "bailian" };

		await expect(importResource(ctx(state), address, "dep_1")).rejects.toThrow(/Invalid resource type/);
		expect(state.listResources()).toEqual([]);
	});

	test("records the remote comparable as the drift baseline when readable", async () => {
		const state = StateManager.initialize("/tmp/import-resource-baseline.json");
		const address: ResourceAddress = { type: "environment", name: "bailian-cli", provider: "bailian" };
		const provider = {
			name: "bailian",
			getDriftSupport: (type: string) => (type === "environment" ? "full" : "unsupported"),
			readComparableResource: async () => ({
				id: "env_remote_1",
				type: "environment",
				comparable: { config: { type: "cloud" } },
				snapshot: { config: { type: "cloud" } },
			}),
		} as unknown as ProviderAdapter;

		const runtime = ctx(state);
		runtime.providers = new Map([["bailian", provider]]);
		const recorded = await importResource(runtime, address, "env_remote_1");

		expect(recorded.desired_comparable_hash).toBeTruthy();
		expect(recorded.remote_hash).toBe(recorded.desired_comparable_hash);
		expect(recorded.drift_status).toBe("in_sync");
	});
});
