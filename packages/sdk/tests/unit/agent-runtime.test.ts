import { describe, expect, test } from "bun:test";
import {
	type AgentReadiness,
	getAgentReadinessFromPlan,
	isAgentRunnable,
	listAgents,
	planAgentResources,
	syncAgentResources,
} from "../../src/internal/core/agent-runtime.ts";
import type { ProjectRuntimeContext } from "../../src/internal/core/project-runtime.ts";
import { planProjectContext } from "../../src/internal/core/resource-runtime.ts";
import { computeResourceHash } from "../../src/internal/planner/hasher.ts";
import { StateManager } from "../../src/internal/state/state-manager.ts";
import type { ProjectConfig } from "../../src/internal/types/config.ts";
import type { ResourceAddress } from "../../src/internal/types/state.ts";
import "../../src/internal/providers/all.ts";

function baseConfig(overrides: Partial<ProjectConfig> = {}): ProjectConfig {
	return {
		version: "1",
		providers: { bailian: { api_key: "test", workspace_id: "ws" } },
		defaults: { provider: "bailian" },
		environments: {
			"bailian-cli": { config: { type: "cloud" } },
		},
		agents: {
			"bailian-cli": {
				description: "Bailian CLI",
				model: "qwen3",
				instructions: "run",
				environment: "bailian-cli",
				tools: {
					builtin: ["bash"],
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
				skills: [{ type: "official", skill_id: "bailian-cli", version: "1.0" }],
			},
		},
		...overrides,
	};
}

function state(resources: Array<ResourceAddress & { remote_id?: string; drifted?: boolean; content_hash?: string }>) {
	const s = StateManager.initialize("/tmp/agent-runtime-state.json");
	for (const r of resources) {
		s.setResource({
			address: { type: r.type, name: r.name, provider: r.provider },
			remote_id: r.remote_id ?? `${r.type}_${r.name}`,
			content_hash: r.content_hash ?? "h",
			desired_hash: r.content_hash ?? "h",
			drift_status: r.drifted ? "drifted" : "in_sync",
		});
	}
	return s;
}

async function matchingState(config: ProjectConfig, resources: ResourceAddress[]): Promise<StateManager> {
	const entries = await Promise.all(
		resources.map(async (resource) => ({
			...resource,
			content_hash: await computeResourceHash(resource, config, "/tmp/agents.yaml"),
		})),
	);
	return state(entries);
}

function ctx(config: ProjectConfig, stateManager: StateManager): ProjectRuntimeContext {
	return {
		configPath: "/tmp/agents.yaml",
		statePath: "/tmp/agents.state.json",
		projectName: "test",
		config: { ...config, _resolved: true },
		state: stateManager,
		providers: new Map(),
	};
}

describe("agent runtime", () => {
	test("derives Bailian CLI agent metadata from agent config", () => {
		const agents = listAgents(ctx(baseConfig(), state([])));

		expect(agents).toHaveLength(1);
		expect(agents[0]).toMatchObject({
			id: "bailian-cli",
			agentName: "bailian-cli",
			provider: "bailian",
			environment: "bailian-cli",
			description: "Bailian CLI",
			mcpServers: ["WebSearch"],
		});
		expect(agents[0]?.skills).toEqual([{ type: "official", id: "bailian-cli", version: "1.0" }]);
	});

	test("ready when required state refs exist", async () => {
		const c = baseConfig();
		const s = state([
			{ type: "agent", name: "bailian-cli", provider: "bailian" },
			{ type: "environment", name: "bailian-cli", provider: "bailian" },
		]);
		const runtime = ctx(c, s);

		const readiness = getAgentReadinessFromPlan(runtime, "bailian-cli", {
			diagnostics: [],
			actions: [
				{
					action: "no-op",
					address: { type: "environment", name: "bailian-cli", provider: "bailian" },
					reason: "No changes detected",
					dependencies: [],
				},
				{
					action: "no-op",
					address: { type: "agent", name: "bailian-cli", provider: "bailian" },
					reason: "No changes detected",
					dependencies: [{ type: "environment", name: "bailian-cli", provider: "bailian" }],
				},
			],
		});

		expect(readiness.status).toBe("ready");
		expect(readiness.missing).toEqual([]);
	});

	test("missing when required state refs are missing", async () => {
		const runtime = ctx(baseConfig(), state([]));
		const plan = await planProjectContext(runtime, { refresh: false });

		const readiness = getAgentReadinessFromPlan(runtime, "bailian-cli", plan.plan);

		expect(readiness.status).toBe("missing");
		expect(readiness.missing.map((a) => `${a.type}.${a.name}`)).toContain("agent.bailian-cli");
		expect(readiness.missing.map((a) => `${a.type}.${a.name}`)).toContain("environment.bailian-cli");
	});

	test("invalid when agent references undeclared environment", async () => {
		const c = baseConfig({
			agents: {
				"bailian-cli": {
					...baseConfig().agents!["bailian-cli"]!,
					environment: "ghost",
				},
			},
		});
		const runtime = ctx(c, state([{ type: "agent", name: "bailian-cli", provider: "bailian" }]));
		const plan = await planProjectContext(runtime, { refresh: false });

		const readiness = getAgentReadinessFromPlan(runtime, "bailian-cli", plan.plan);

		expect(readiness.status).toBe("invalid");
		expect(readiness.diagnostics.some((d) => d.code === "config.agent.environment.unknown")).toBe(true);
	});

	test("drifted when agent dependency has remote drift", async () => {
		const runtime = ctx(
			baseConfig(),
			state([
				{ type: "agent", name: "bailian-cli", provider: "bailian", drifted: true },
				{ type: "environment", name: "bailian-cli", provider: "bailian" },
			]),
		);
		const plan = await planProjectContext(runtime, { refresh: false });

		const readiness = getAgentReadinessFromPlan(runtime, "bailian-cli", plan.plan);

		expect(readiness.status).toBe("drifted");
		expect(readiness.driftSeverity).toBe("blocking");
	});

	test("uses structured plan impact instead of reason text for non-blocking drift", async () => {
		const runtime = ctx(
			baseConfig(),
			state([
				{ type: "agent", name: "bailian-cli", provider: "bailian" },
				{ type: "environment", name: "bailian-cli", provider: "bailian" },
			]),
		);

		const readiness = getAgentReadinessFromPlan(runtime, "bailian-cli", {
			diagnostics: [],
			actions: [
				{
					action: "update",
					address: { type: "agent", name: "bailian-cli", provider: "bailian" },
					reason: "任意展示文案，不参与 readiness 判断",
					readinessImpact: "non_blocking",
					dependencies: [],
				},
			],
		});

		expect(readiness.status).toBe("drifted");
		expect(readiness.driftSeverity).toBe("non_blocking");
	});

	test("agent resource plan scopes actions to agent resources and dependencies", async () => {
		const runtime = ctx(
			baseConfig({
				environments: {
					"bailian-cli": { config: { type: "cloud" } },
					unrelated: { config: { type: "cloud" } },
				},
				agents: {
					"bailian-cli": baseConfig().agents!["bailian-cli"]!,
					unrelated: {
						model: "qwen3",
						instructions: "ignore",
						environment: "unrelated",
					},
				},
			}),
			state([]),
		);

		const plan = await planAgentResources(runtime, "bailian-cli", {
			refresh: false,
		});

		const addresses = plan.actions.map((action) => `${action.address.type}.${action.address.name}`);
		expect(addresses).toContain("agent.bailian-cli");
		expect(addresses).toContain("environment.bailian-cli");
		expect(addresses).not.toContain("agent.unrelated");
		expect(addresses).not.toContain("environment.unrelated");
		expect(plan.provider).toBe("bailian");
	});

	test("scoped Agent planning excludes unrelated validation errors", async () => {
		const runtime = ctx(
			baseConfig({
				agents: {
					"bailian-cli": baseConfig().agents!["bailian-cli"]!,
					unrelated: {
						model: "qwen3",
						instructions: "ignore",
						environment: "missing-unrelated-environment",
					},
				},
			}),
			state([]),
		);

		const plan = await planAgentResources(runtime, "bailian-cli", { refresh: false });

		expect(plan.diagnostics.some((diagnostic) => diagnostic.message.includes("missing-unrelated"))).toBe(false);
	});

	test("scoped Agent refresh never reads unrelated state resources", async () => {
		const config = baseConfig({
			environments: {
				"bailian-cli": { config: { type: "cloud" } },
				unrelated: { config: { type: "cloud" } },
			},
			agents: {
				"bailian-cli": baseConfig().agents!["bailian-cli"]!,
				unrelated: { model: "qwen3", instructions: "ignore", environment: "unrelated" },
			},
		});
		const runtime = ctx(
			config,
			await matchingState(config, [
				{ type: "agent", name: "bailian-cli", provider: "bailian" },
				{ type: "environment", name: "bailian-cli", provider: "bailian" },
				{ type: "agent", name: "unrelated", provider: "bailian" },
				{ type: "environment", name: "unrelated", provider: "bailian" },
			]),
		);
		const reads: string[] = [];
		runtime.providers.set("bailian", {
			name: "bailian",
			getDriftSupport: () => "existence",
			findResource: async (type: string, name: string, remoteId: string) => {
				reads.push(`${type}.${name}`);
				return { id: remoteId, type };
			},
		} as never);

		await planAgentResources(runtime, "bailian-cli", { refresh: true });

		expect(reads.sort()).toEqual(["agent.bailian-cli", "environment.bailian-cli"]);
	});

	test("create-only blocks when a dependency is not already reconciled", async () => {
		const run = await syncAgentResources(ctx(baseConfig(), state([])), "bailian-cli", {
			refresh: false,
			mode: "create-only",
		});

		expect(run.status).toBe("blocked");
		expect(run.error).toMatch(/Reconcile first.*environment\.bailian-cli/);
		expect(run.results).toEqual([]);
	});

	test("create-only creates only the target Agent when dependencies are no-op", async () => {
		const config = baseConfig();
		const runtime = ctx(
			config,
			await matchingState(config, [{ type: "environment", name: "bailian-cli", provider: "bailian" }]),
		);
		const created: string[] = [];
		runtime.providers.set("bailian", {
			name: "bailian",
			createAgent: async (name: string) => {
				created.push(name);
				return { id: "agent_created", type: "agent" };
			},
		} as never);

		const run = await syncAgentResources(runtime, "bailian-cli", {
			refresh: false,
			mode: "create-only",
		});

		expect(run.status).toBe("completed");
		expect(created).toEqual(["bailian-cli"]);
		expect(run.results).toHaveLength(1);
		expect(run.results[0]?.action.address).toEqual({
			type: "agent",
			name: "bailian-cli",
			provider: "bailian",
		});
	});

	test("agent sync never deletes stale state outside the dependency closure", async () => {
		const c = baseConfig({
			environments: {},
			agents: {
				"bailian-cli": {
					...baseConfig().agents!["bailian-cli"]!,
					environment: "ghost",
				},
			},
		});
		const runtime = ctx(c, state([{ type: "environment", name: "ghost", provider: "bailian" }]));
		const planned = await planProjectContext(runtime, { refresh: false });

		const run = await syncAgentResources(runtime, "bailian-cli", {
			refresh: false,
		});

		expect(planned.plan.actions.some((action) => action.action === "delete")).toBe(true);
		expect(run.status).toBe("blocked");
		expect(run.destructiveActions).toHaveLength(0);
		expect(run.results).toEqual([]);
	});

	test("agent sync does not prompt for stale state outside the dependency closure", async () => {
		const c = baseConfig({
			environments: {},
			agents: {
				"bailian-cli": {
					...baseConfig().agents!["bailian-cli"]!,
					environment: "ghost",
				},
			},
		});
		const runtime = ctx(c, state([{ type: "environment", name: "ghost", provider: "bailian" }]));

		let confirmed = false;
		const run = await syncAgentResources(runtime, "bailian-cli", {
			refresh: false,
			policy: "prompt",
			confirm: () => {
				confirmed = true;
				return false;
			},
		});

		expect(confirmed).toBe(false);
		expect(run.status).toBe("blocked");
		expect(run.results).toEqual([]);
	});

	test("agent sync completes when no scoped actions need execution", async () => {
		const c = baseConfig();
		const runtime = ctx(
			c,
			await matchingState(c, [
				{ type: "agent", name: "bailian-cli", provider: "bailian" },
				{ type: "environment", name: "bailian-cli", provider: "bailian" },
			]),
		);

		const run = await syncAgentResources(runtime, "bailian-cli", {
			refresh: false,
		});

		expect(run.status).toBe("completed");
		expect(run.destructiveActions).toEqual([]);
		expect(run.results).toEqual([]);
	});
});

describe("isAgentRunnable", () => {
	function readiness(
		status: AgentReadiness["status"],
		driftSeverity?: AgentReadiness["driftSeverity"],
	): AgentReadiness {
		return { status, agentId: "a", driftSeverity, diagnostics: [], missing: [], plannedActions: [] };
	}

	test("ready or non-blocking drift is runnable", () => {
		expect(isAgentRunnable(readiness("ready"))).toBe(true);
		expect(isAgentRunnable(readiness("drifted", "non_blocking"))).toBe(true);
	});

	test("missing, unavailable, or blocking drift is not runnable", () => {
		expect(isAgentRunnable(readiness("missing"))).toBe(false);
		expect(isAgentRunnable(readiness("unavailable"))).toBe(false);
		expect(isAgentRunnable(readiness("drifted", "blocking"))).toBe(false);
	});
});
