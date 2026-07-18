import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { destroyPlannedProjectResources, planDestroyProjectContext } from "../../src/internal/core/destroy-runtime.ts";
import type { ProjectRuntimeContext } from "../../src/internal/core/project-runtime.ts";
import { UserError } from "../../src/internal/errors.ts";
import { ApiError } from "../../src/internal/providers/base-client.ts";
import type { ProviderAdapter } from "../../src/internal/providers/interface.ts";
import { StateManager } from "../../src/internal/state/state-manager.ts";
import type { ProjectConfig } from "../../src/internal/types/config.ts";
import type { ResourceState, ResourceType } from "../../src/internal/types/state.ts";

const tempDirs: string[] = [];

afterEach(async () => {
	while (tempDirs.length > 0) {
		await rm(tempDirs.pop()!, { recursive: true, force: true });
	}
});

async function makeStatePath(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "agents-destroy-"));
	tempDirs.push(dir);
	return join(dir, "agents.state.json");
}

function resource(type: ResourceType, name: string, remoteId = `${type}_${name}`): ResourceState {
	return {
		address: { type, name, provider: "qoder" },
		remote_id: remoteId,
		content_hash: "h",
		desired_hash: "h",
	};
}

async function state(resources: ResourceState[]): Promise<StateManager> {
	const manager = StateManager.initialize(await makeStatePath());
	for (const item of resources) manager.setResource(item);
	return manager;
}

function config(): ProjectConfig {
	return {
		version: "1",
		providers: { qoder: { api_key: "test" } },
	};
}

function adapter(calls: string[], overrides: Partial<ProviderAdapter> = {}): ProviderAdapter {
	const base: ProviderAdapter = {
		name: "qoder",
		validate: async () => {},
		findResource: async () => null,
		createEnvironment: async () => ({ id: "env_1", type: "environment" }),
		updateEnvironment: async () => ({ id: "env_1", type: "environment" }),
		deleteEnvironment: async (id, cascade) => calls.push(`environment:${id}:${cascade ? "cascade" : "plain"}`),
		createVault: async () => ({ id: "vault_1", type: "vault" }),
		deleteVault: async (id) => calls.push(`vault:${id}`),
		createSkill: async () => ({ id: "skill_1", type: "skill" }),
		updateSkill: async () => ({ id: "skill_1", type: "skill" }),
		deleteSkill: async (id) => calls.push(`skill:${id}`),
		createAgent: async () => ({ id: "agent_1", type: "agent" }),
		updateAgent: async () => ({ id: "agent_1", type: "agent" }),
		deleteAgent: async (id) => calls.push(`agent:${id}`),
		createMemoryStore: async () => ({ id: "ms_1", type: "memory_store" }),
		deleteMemoryStore: async (id) => calls.push(`memory_store:${id}`),
		createDeployment: async () => ({ id: "dep_1", type: "deployment" }),
		updateDeployment: async () => ({ id: "dep_1", type: "deployment" }),
		deleteDeployment: async (id) => calls.push(`deployment:${id}`),
		runDeployment: async () => ({ session_id: "sess_1" }),
		getDeployment: async () => ({ id: "dep_1", status: "ok" }),
		createSession: async () => session(),
		listSessions: async () => ({ sessions: [session()], has_more: false }),
		getSession: async () => session(),
		deleteSession: async () => {},
		sendSessionMessage: async () => "evt_1",
		streamSessionEvents: async function* () {},
		listSessionEvents: async () => ({ events: [], has_more: false }),
	};
	return { ...base, ...overrides };
}

function session() {
	return {
		id: "sess_1",
		agent_id: "agent_1",
		environment_id: "env_1",
		status: "idle",
		vault_ids: [],
		memory_store_ids: [],
		created_at: "2026-01-01T00:00:00Z",
		updated_at: "2026-01-01T00:00:01Z",
		attributes: {},
	};
}

async function ctx(resources: ResourceState[], provider: ProviderAdapter): Promise<ProjectRuntimeContext> {
	return {
		configPath: "/tmp/agents.yaml",
		statePath: "/tmp/agents.state.json",
		projectName: "test",
		config: { ...config(), _resolved: true },
		state: await state(resources),
		providers: new Map([[provider.name, provider]]),
	};
}

describe("destroy runtime", () => {
	test("plans resources in dependency-safe destroy order", async () => {
		const runtime: ProjectRuntimeContext = {
			projectName: "test",
			config: { ...config(), _resolved: true },
			state: await state([
				resource("environment", "dev"),
				resource("vault", "secrets"),
				resource("deployment", "daily"),
				resource("agent", "assistant"),
				resource("memory_store", "docs"),
				resource("skill", "review"),
			]),
			providers: new Map(),
		};

		const plan = planDestroyProjectContext(runtime);

		expect(plan.resources.map((item) => item.address.type)).toEqual([
			"deployment",
			"agent",
			"skill",
			"memory_store",
			"vault",
			"environment",
		]);
	});

	test("dispatches provider deletion and removes state", async () => {
		const calls: string[] = [];
		const runtime = await ctx(
			[resource("agent", "assistant", "agent_remote"), resource("environment", "dev", "env_remote")],
			adapter(calls),
		);

		const result = await destroyPlannedProjectResources(planDestroyProjectContext(runtime));

		expect(calls).toEqual(["agent:agent_remote", "environment:env_remote:plain"]);
		expect(result.destroyed).toBe(2);
		expect(runtime.state.listResources()).toEqual([]);
	});

	test("removes an external environment from state without deleting it remotely", async () => {
		const calls: string[] = [];
		const runtime = await ctx([resource("environment", "byoc", "env_byoc")], adapter(calls));
		runtime.config.environments = {
			byoc: { environment_id: "env_byoc", config: { type: "self_hosted" } },
		};

		const result = await destroyPlannedProjectResources(planDestroyProjectContext(runtime));

		expect(result.destroyed).toBe(1);
		expect(calls).toEqual([]);
		expect(runtime.state.listResources()).toEqual([]);
	});

	test("removes a formerly declared external environment from state without deleting it remotely", async () => {
		const calls: string[] = [];
		const external = resource("environment", "byoc", "env_byoc");
		external.externally_managed = true;
		const runtime = await ctx([external], adapter(calls));

		const result = await destroyPlannedProjectResources(planDestroyProjectContext(runtime));

		expect(result.destroyed).toBe(1);
		expect(calls).toEqual([]);
		expect(runtime.state.listResources()).toEqual([]);
	});

	test("treats remote 404 as successful state cleanup", async () => {
		const calls: string[] = [];
		const runtime = await ctx(
			[resource("agent", "assistant", "agent_remote")],
			adapter(calls, {
				deleteAgent: async () => {
					throw new ApiError(404, "missing", "Test API");
				},
			}),
		);

		const result = await destroyPlannedProjectResources(planDestroyProjectContext(runtime));

		expect(result.results[0]).toMatchObject({
			status: "success",
			reason: "already_gone",
		});
		expect(runtime.state.listResources()).toEqual([]);
	});

	test("blocks cascade-required environment deletion unless caller opts in", async () => {
		const runtime = await ctx(
			[resource("environment", "dev", "env_remote")],
			adapter([], {
				deleteEnvironment: async (_id, cascade) => {
					if (!cascade) throw new UserError("Environment is referenced by sessions");
				},
			}),
		);

		const result = await destroyPlannedProjectResources(planDestroyProjectContext(runtime));

		expect(result.results[0]).toMatchObject({
			status: "blocked",
			reason: "cascade_required",
		});
		expect(runtime.state.listResources()).toHaveLength(1);
	});

	test("retries cascade-required environment deletion when caller approves", async () => {
		const calls: string[] = [];
		const runtime = await ctx(
			[resource("environment", "dev", "env_remote")],
			adapter(calls, {
				deleteEnvironment: async (id, cascade) => {
					calls.push(`environment:${id}:${cascade ? "cascade" : "plain"}`);
					if (!cascade) throw new UserError("Environment is referenced by sessions");
				},
			}),
		);

		const result = await destroyPlannedProjectResources(planDestroyProjectContext(runtime), {
			onCascadeRequired: () => true,
		});

		expect(calls).toEqual(["environment:env_remote:plain", "environment:env_remote:cascade"]);
		expect(result.results[0]).toMatchObject({
			status: "success",
			reason: "destroyed",
			cascaded: true,
		});
		expect(runtime.state.listResources()).toEqual([]);
	});

	test("reports partial failure without removing failed resources", async () => {
		const runtime = await ctx(
			[resource("agent", "assistant", "agent_remote")],
			adapter([], {
				deleteAgent: async () => {
					throw new Error("boom");
				},
			}),
		);

		const result = await destroyPlannedProjectResources(planDestroyProjectContext(runtime));

		expect(result.partial).toBe(true);
		expect(result.results[0]).toMatchObject({
			status: "failed",
			reason: "failed",
			error: "boom",
		});
		expect(runtime.state.listResources()).toHaveLength(1);
	});
});
