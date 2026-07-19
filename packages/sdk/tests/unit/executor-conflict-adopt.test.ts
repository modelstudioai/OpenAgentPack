import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecContext } from "../../src/internal/executor/context.ts";
import { executePlan } from "../../src/internal/executor/executor.ts";
import { ApiError, ConflictError } from "../../src/internal/providers/base-client.ts";
import type { ProviderAdapter, RemoteResource } from "../../src/internal/providers/interface.ts";
import type { IStateManager } from "../../src/internal/state/state-manager.ts";
import { StateManager } from "../../src/internal/state/state-manager.ts";
import type { ProjectConfig } from "../../src/internal/types/config.ts";
import type { ExecutionPlan } from "../../src/internal/types/plan.ts";

function tmpPath(): string {
	return join(tmpdir(), `exec-conflict-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

const config: ProjectConfig = {
	version: "1",
	providers: { bailian: { api_key: "test", workspace_id: "ws" } },
	defaults: { provider: "bailian" },
	environments: {
		"my-env": {
			description: "Test env",
			config: { type: "cloud" },
		},
	},
};

function createPlan(): ExecutionPlan {
	return {
		actions: [
			{
				action: "create",
				address: { type: "environment", name: "my-env", provider: "bailian" },
				reason: "Resource does not exist in state",
				after: { content_hash: "h" },
				dependencies: [],
			},
		],
		diagnostics: [],
	};
}

function makeCtx(
	provider: ProviderAdapter,
	state: IStateManager = StateManager.initialize(tmpPath()),
	ctxConfig: ProjectConfig = config,
): ExecContext {
	return {
		config: ctxConfig,
		configPath: "/tmp/agents.yaml",
		providers: new Map([["bailian", provider]]),
		state,
	};
}

const existingResource: RemoteResource = { id: "env_existing", type: "environment", version: 3 };

describe("executor conflict-adopt", () => {
	test("ConflictError → findResource finds existing → onExisting rebuilds via updateEnvironment", async () => {
		const calls: string[] = [];
		const provider = {
			name: "bailian",
			validate: async () => {},
			findResource: async () => existingResource,
			createEnvironment: async () => {
				throw new ConflictError(409, "已存在", "Bailian API");
			},
			updateEnvironment: async (id: string) => {
				calls.push(`updateEnvironment:${id}`);
				return { id, type: "environment", version: 4 };
			},
			deleteEnvironment: async () => {},
		} as unknown as ProviderAdapter;

		const state = StateManager.initialize(tmpPath());
		const result = await executePlan(createPlan(), makeCtx(provider, state));

		expect(result.partial).toBe(false);
		expect(result.results[0].status).toBe("success");
		expect(calls).toEqual(["updateEnvironment:env_existing"]);
		const saved = state.getResource({ type: "environment", name: "my-env", provider: "bailian" })!;
		expect(saved.remote_id).toBe("env_existing");
	});

	test("ConflictError → findResource returns null → nameReservedError with actionable guidance", async () => {
		const provider = {
			name: "bailian",
			validate: async () => {},
			findResource: async () => null,
			createEnvironment: async () => {
				throw new ConflictError(409, "已存在", "Bailian API");
			},
			updateEnvironment: async () => ({ id: "x", type: "environment" }),
			deleteEnvironment: async () => {},
		} as unknown as ProviderAdapter;

		const result = await executePlan(createPlan(), makeCtx(provider));

		expect(result.partial).toBe(true);
		expect(result.results[0].status).toBe("failed");
		expect(result.results[0].error?.message).toContain("already exists");
		expect(result.results[0].error?.message).toContain("could not be found remotely to adopt");
		expect(result.results[0].error?.message).toContain("Wait for the provider to release the name");
	});

	test("non-conflict ApiError(500) rethrows without attempting adopt", async () => {
		const calls: string[] = [];
		const provider = {
			name: "bailian",
			validate: async () => {},
			findResource: async () => {
				calls.push("findResource");
				return existingResource;
			},
			createEnvironment: async () => {
				throw new ApiError(500, "internal server error", "Bailian API");
			},
			updateEnvironment: async () => {
				calls.push("updateEnvironment");
				return { id: "x", type: "environment" };
			},
			deleteEnvironment: async () => {},
		} as unknown as ProviderAdapter;

		const result = await executePlan(createPlan(), makeCtx(provider));

		expect(result.partial).toBe(true);
		expect(result.results[0].status).toBe("failed");
		expect(result.results[0].error?.message).toContain("500");
		expect(calls).toEqual([]);
	});

	test("skill ConflictError → multi searchNames → adopt as-is without rebuild", async () => {
		const skillConfig: ProjectConfig = {
			version: "1",
			providers: { bailian: { api_key: "test", workspace_id: "ws" } },
			defaults: { provider: "bailian" },
			skills: {
				"my-skill": {
					source: "skills/my-skill",
				},
			},
		};

		const existingSkill: RemoteResource = { id: "skill_remote", type: "skill" };
		let findCalls = 0;
		const provider = {
			name: "bailian",
			validate: async () => {},
			findResource: async () => {
				findCalls += 1;
				return findCalls === 1 ? null : existingSkill;
			},
			createSkill: async () => {
				throw new ConflictError(409, "已存在自定义相同SkillName", "Bailian API");
			},
			updateSkill: async () => {
				throw new Error("updateSkill should not be called — skill adopt is as-is");
			},
			deleteSkill: async () => {},
			uploadFile: async () => ({ id: "file_1", name: "test.zip", purpose: "skill", size: 100 }),
			deleteFile: async () => {},
		} as unknown as ProviderAdapter;

		const skillPlan: ExecutionPlan = {
			actions: [
				{
					action: "create",
					address: { type: "skill", name: "my-skill", provider: "bailian" },
					reason: "Resource does not exist in state",
					after: { content_hash: "h" },
					dependencies: [],
				},
			],
			diagnostics: [],
		};

		const state = StateManager.initialize(tmpPath());
		const ctx: ExecContext = {
			config: skillConfig,
			configPath: "/tmp/agents.yaml",
			providers: new Map([["bailian", provider]]),
			state,
		};

		const result = await executePlan(skillPlan, ctx);

		expect(result.partial).toBe(false);
		expect(result.results[0].status).toBe("success");
		const saved = state.getResource({ type: "skill", name: "my-skill", provider: "bailian" })!;
		expect(saved.remote_id).toBe("skill_remote");
	});
});

describe("executor external-reference environment", () => {
	const byocConfig: ProjectConfig = {
		version: "1",
		providers: { bailian: { api_key: "test", workspace_id: "ws" } },
		defaults: { provider: "bailian" },
		environments: {
			"byoc-env": {
				environment_id: "env_byoc_xyz",
				config: { type: "self_hosted" },
			},
		},
	};

	test("create action skips remote mutation and records environment_id in state", async () => {
		const calls: string[] = [];
		const provider = {
			name: "bailian",
			validate: async () => {},
			findResource: async () => null,
			createEnvironment: async () => {
				calls.push("createEnvironment");
				return { id: "should_not_be_used", type: "environment" };
			},
			updateEnvironment: async () => {
				calls.push("updateEnvironment");
				return { id: "should_not_be_used", type: "environment" };
			},
			deleteEnvironment: async () => {
				calls.push("deleteEnvironment");
			},
		} as unknown as ProviderAdapter;

		const plan: ExecutionPlan = {
			actions: [
				{
					action: "create",
					address: { type: "environment", name: "byoc-env", provider: "bailian" },
					reason: "Resource does not exist in state",
					after: { content_hash: "h" },
					dependencies: [],
				},
			],
			diagnostics: [],
		};

		const state = StateManager.initialize(tmpPath());
		const result = await executePlan(plan, makeCtx(provider, state, byocConfig));

		expect(result.partial).toBe(false);
		expect(result.results[0].status).toBe("success");
		expect(calls).toEqual([]);
		const saved = state.getResource({ type: "environment", name: "byoc-env", provider: "bailian" })!;
		expect(saved.remote_id).toBe("env_byoc_xyz");
		expect(saved.externally_managed).toBe(true);
	});

	test("removing an external environment from config only removes its state", async () => {
		const calls: string[] = [];
		const provider = {
			name: "bailian",
			validate: async () => {},
			findResource: async () => null,
			createEnvironment: async () => ({ id: "x", type: "environment" }),
			updateEnvironment: async () => ({ id: "x", type: "environment" }),
			deleteEnvironment: async () => {
				calls.push("deleteEnvironment");
			},
		} as unknown as ProviderAdapter;

		const plan: ExecutionPlan = {
			actions: [
				{
					action: "delete",
					address: { type: "environment", name: "byoc-env", provider: "bailian" },
					reason: "Resource removed from configuration",
					before: { content_hash: "h" },
					dependencies: [],
				},
			],
			diagnostics: [],
		};

		const state = StateManager.initialize(tmpPath());
		state.setResource({
			address: { type: "environment", name: "byoc-env", provider: "bailian" },
			remote_id: "env_byoc_xyz",
			externally_managed: true,
			content_hash: "h",
		});

		const configWithoutExternalEnvironment: ProjectConfig = {
			...byocConfig,
			environments: undefined,
		};
		const result = await executePlan(plan, makeCtx(provider, state, configWithoutExternalEnvironment));

		expect(result.partial).toBe(false);
		expect(result.results[0].status).toBe("success");
		expect(calls).toEqual([]);
		expect(state.getResource({ type: "environment", name: "byoc-env", provider: "bailian" })).toBeUndefined();
	});

	test("marks an existing external environment during a no-op apply", async () => {
		const provider = {
			name: "bailian",
			validate: async () => {},
			findResource: async () => null,
		} as unknown as ProviderAdapter;
		const state = StateManager.initialize(tmpPath());
		const address = { type: "environment" as const, name: "byoc-env", provider: "bailian" };
		state.setResource({ address, remote_id: "env_byoc_xyz", content_hash: "h" });
		const plan: ExecutionPlan = {
			actions: [{ action: "no-op", address, reason: "No changes detected", dependencies: [] }],
			diagnostics: [],
		};

		await executePlan(plan, makeCtx(provider, state, byocConfig));

		expect(state.getResource(address)?.externally_managed).toBe(true);
	});
});

describe("executor recreate-on-vanished-remote", () => {
	test("falls back to create when an update fails with 404", async () => {
		const calls: string[] = [];
		const provider = {
			name: "bailian",
			validate: async () => {},
			findResource: async () => null,
			updateEnvironment: async () => {
				calls.push("updateEnvironment");
				throw new ApiError(404, "Environment 'env_old' was not found.", "test");
			},
			createEnvironment: async () => {
				calls.push("createEnvironment");
				return { id: "env_new", type: "environment" };
			},
		} as unknown as ProviderAdapter;

		const address = { type: "environment" as const, name: "my-env", provider: "bailian" };
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

		const state = StateManager.initialize(tmpPath());
		state.setResource({ address, remote_id: "env_old", content_hash: "h_old" });

		const result = await executePlan(plan, makeCtx(provider, state));

		expect(calls).toEqual(["updateEnvironment", "createEnvironment"]);
		expect(result.results[0]?.status).toBe("success");
		expect(state.getResource(address)?.remote_id).toBe("env_new");
	});

	test("does not retry non-404 update failures", async () => {
		const calls: string[] = [];
		const provider = {
			name: "bailian",
			validate: async () => {},
			findResource: async () => null,
			updateEnvironment: async () => {
				calls.push("updateEnvironment");
				throw new ApiError(500, "boom", "test");
			},
			createEnvironment: async () => {
				calls.push("createEnvironment");
				return { id: "env_new", type: "environment" };
			},
		} as unknown as ProviderAdapter;

		const address = { type: "environment" as const, name: "my-env", provider: "bailian" };
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

		const state = StateManager.initialize(tmpPath());
		state.setResource({ address, remote_id: "env_old", content_hash: "h_old" });

		const result = await executePlan(plan, makeCtx(provider, state));

		expect(calls).toEqual(["updateEnvironment"]);
		expect(result.results[0]?.status).toBe("failed");
	});
});
