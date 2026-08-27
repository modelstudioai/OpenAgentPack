import { describe, expect, test } from "bun:test";
import type { ProjectRuntimeContext } from "../../src/internal/core/project-runtime.ts";
import { planProjectContext } from "../../src/internal/core/resource-runtime.ts";
import { computeResourceHash } from "../../src/internal/planner/hasher.ts";
import { StateManager } from "../../src/internal/state/state-manager.ts";
import type { ResolvedProjectConfig } from "../../src/internal/types/config.ts";
import type { ResourceAddress } from "../../src/internal/types/state.ts";
import "../../src/internal/providers/all.ts";

const provider = "bailian";

function config(): ResolvedProjectConfig {
	return {
		version: "1",
		providers: { bailian: { api_key: "test", workspace_id: "ws" } },
		defaults: { provider },
		environments: {
			dev: { config: { type: "cloud" } },
			unrelated: { config: { type: "cloud" } },
		},
		vaults: { secrets: { display_name: "Secrets", credentials: [] } },
		skills: { review: { source: "./missing-skill", origin: "custom" } },
		agents: {
			assistant: { model: "qwen3", instructions: "help", environment: "dev" },
		},
		deployments: {
			daily: {
				name: "Daily Report",
				agent: "assistant",
				environment: "dev",
				initial_events: [{ type: "user.message", content: "run" }],
			},
		},
		_resolved: true,
	};
}

function runtime(resolvedConfig: ResolvedProjectConfig, state = StateManager.initialize("/tmp/create-only.json")) {
	return {
		projectName: "test",
		configPath: "/tmp/agents.yaml",
		config: resolvedConfig,
		state,
		providers: new Map(),
	} as ProjectRuntimeContext;
}

async function seedMatchingState(
	resolvedConfig: ResolvedProjectConfig,
	addresses: ResourceAddress[],
): Promise<StateManager> {
	const state = StateManager.initialize("/tmp/create-only-state.json");
	for (const address of addresses) {
		const hash = await computeResourceHash(address, resolvedConfig, "/tmp/agents.yaml", state);
		state.setResource({
			address,
			remote_id: `${address.type}_${address.name}`,
			content_hash: hash,
			desired_hash: hash,
			drift_status: "in_sync",
		});
	}
	return state;
}

describe("generic resource create-only planning", () => {
	test.each([
		["environment", "dev"],
		["vault", "secrets"],
		["skill", "review"],
	] as const)("accepts a new scoped %s root", async (type, name) => {
		const address: ResourceAddress = { type, name, provider };
		const planned = await planProjectContext(runtime(config()), {
			provider,
			scope: { roots: [address] },
			mode: "create-only",
			refresh: false,
		});

		expect(planned.plan.actions).toHaveLength(1);
		expect(planned.plan.actions[0]).toMatchObject({ action: "create", address });
		expect(planned.plan.diagnostics.some((diagnostic) => diagnostic.severity === "error")).toBe(false);
	});

	test("allows Deployment create when its transitive dependencies are no-op", async () => {
		const resolvedConfig = config();
		const state = await seedMatchingState(resolvedConfig, [
			{ type: "environment", name: "dev", provider },
			{ type: "agent", name: "assistant", provider },
		]);
		const root: ResourceAddress = { type: "deployment", name: "daily", provider };
		const planned = await planProjectContext(runtime(resolvedConfig, state), {
			provider,
			scope: { roots: [root] },
			mode: "create-only",
			refresh: false,
		});

		expect(planned.plan.actions.find((action) => action.address.type === "deployment")?.action).toBe("create");
		expect(
			planned.plan.actions
				.filter((action) => action.address.type !== "deployment")
				.every((action) => action.action === "no-op"),
		).toBe(true);
		expect(planned.plan.diagnostics.some((diagnostic) => diagnostic.severity === "error")).toBe(false);
	});

	test("blocks when the target already exists or a dependency needs reconciliation", async () => {
		const resolvedConfig = config();
		const existingEnvironment = await seedMatchingState(resolvedConfig, [
			{ type: "environment", name: "dev", provider },
		]);
		const existingPlan = await planProjectContext(runtime(resolvedConfig, existingEnvironment), {
			provider,
			scope: { roots: [{ type: "environment", name: "dev", provider }] },
			mode: "create-only",
			refresh: false,
		});
		expect(existingPlan.plan.diagnostics).toContainEqual(
			expect.objectContaining({ code: "resource.create_only.blocked", severity: "error" }),
		);

		const dependencyPlan = await planProjectContext(runtime(resolvedConfig), {
			provider,
			scope: { roots: [{ type: "agent", name: "assistant", provider }] },
			mode: "create-only",
			refresh: false,
		});
		expect(dependencyPlan.plan.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "resource.create_only.blocked",
				message: expect.stringContaining("environment.dev (create)"),
			}),
		);
	});

	test("requires scope and leaves full planning behavior unchanged", async () => {
		await expect(
			planProjectContext(runtime(config()), { provider, mode: "create-only", refresh: false }),
		).rejects.toThrow(/requires an explicit resource scope/);

		const fullPlan = await planProjectContext(runtime(config()), { provider, refresh: false });
		expect(fullPlan.plan.actions).toContainEqual(
			expect.objectContaining({
				action: "create",
				address: { type: "environment", name: "unrelated", provider },
			}),
		);
	});
});
