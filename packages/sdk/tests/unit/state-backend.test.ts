import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProjectRuntime, writeProjectRuntime } from "../../src/internal/core/project-runtime.ts";
import { replaceResourcePlan, syncProjectResourcesWithStateBackend } from "../../src/internal/core/resource-runtime.ts";
import { computeResourceHash } from "../../src/internal/planner/hasher.ts";
import type { StateScope } from "../../src/internal/state/backend.ts";
import { InMemoryStateBackend } from "../../src/internal/state/in-memory-state-backend.ts";
import { LocalFileStateBackend } from "../../src/internal/state/local-file-state-backend.ts";
import type { ResolvedProjectConfig } from "../../src/internal/types/config.ts";
import type { ResourceAddress, ResourceState } from "../../src/internal/types/state.ts";

const scope: StateScope = {
	projectId: "project-a",
};

function resource(name: string): ResourceState {
	return {
		address: { provider: "qoder", type: "agent", name },
		remote_id: `agent_${name}`,
		content_hash: "hash",
		desired_hash: "hash",
	};
}

describe("state backend contracts", () => {
	test("in-memory backend read does not commit mutations", async () => {
		const backend = new InMemoryStateBackend();

		await backend.write(scope, (state) => {
			state.setResource(resource("initial"));
		});

		await backend.read(scope, (state) => {
			state.setResource(resource("read-only"));
		});

		expect(backend.getState(scope).resources.map((item) => item.address.name)).toEqual(["initial"]);
	});

	test("in-memory backend write commits mutations", async () => {
		const backend = new InMemoryStateBackend();

		await backend.write(scope, (state) => {
			state.setResource(resource("committed"));
		});

		expect(backend.getState(scope).resources.map((item) => item.address.name)).toEqual(["committed"]);
	});
});

describe("local file state backend", () => {
	test("derives state path from config path", async () => {
		const backend = new LocalFileStateBackend({ configPath: "/workspace/project/agents.yaml" });

		expect(backend.getStatePath(scope)).toBe("/workspace/project/agents.state.json");
	});

	test("loads legacy state and saves slim state through local backend", async () => {
		const dir = await mkdtemp(join(tmpdir(), "agents-state-backend-"));
		const statePath = join(dir, "agents.state.json");
		await Bun.write(
			statePath,
			JSON.stringify({
				version: 1,
				serial: 3,
				lineage: "legacy",
				resources: [
					{
						address: { provider: "qoder", type: "agent", name: "legacy" },
						remote_id: "agent_legacy",
						content_hash: "hash",
						created_at: "2026-01-01T00:00:00Z",
						attributes: { extra: true },
					},
				],
			}),
		);
		const backend = new LocalFileStateBackend({ statePath });

		await backend.write(scope, (state) => {
			expect(state.listResources()[0]!.remote_id).toBe("agent_legacy");
			state.setResource(resource("new"));
		});

		const saved = await Bun.file(statePath).json();
		expect(saved.serial).toBeUndefined();
		expect(saved.lineage).toBeUndefined();
		expect(saved.resources.map((item: ResourceState) => item.address.name).sort()).toEqual(["legacy", "new"]);
		expect(saved.resources[0].attributes).toBeUndefined();
	});
});

describe("backend-scoped runtime helpers", () => {
	const config: ResolvedProjectConfig = {
		version: "1",
		providers: { qoder: { api_key: "test" } },
		_resolved: true,
	};

	test("read runtime does not commit state mutations", async () => {
		const backend = new InMemoryStateBackend();

		await readProjectRuntime(
			{
				projectName: "project-a",
				config,
				stateBackend: backend,
				stateScope: scope,
			},
			(ctx) => {
				ctx.state.setResource(resource("read-runtime"));
			},
		);

		expect(backend.getState(scope).resources).toEqual([]);
	});

	test("write runtime commits state mutations", async () => {
		const backend = new InMemoryStateBackend();

		await writeProjectRuntime(
			{
				projectName: "project-a",
				config,
				stateBackend: backend,
				stateScope: scope,
			},
			(ctx) => {
				ctx.state.setResource(resource("write-runtime"));
			},
		);

		expect(backend.getState(scope).resources.map((item) => item.address.name)).toEqual(["write-runtime"]);
	});
});

describe("resource state-managed pair", () => {
	const resourceConfig: ResolvedProjectConfig = {
		version: "1",
		providers: { qoder: { api_key: "test" } },
		defaults: { provider: "qoder" },
		environments: { dev: { config: { type: "cloud" } } },
		_resolved: true,
	};

	test("plans, applies, and persists state in a single call", async () => {
		const backend = new InMemoryStateBackend();
		const address: ResourceAddress = { provider: "qoder", type: "environment", name: "dev" };
		// Seed state with the exact desired hash so the plan is a no-op — proving the
		// one-call plan → apply → persist wiring without any live provider mutation.
		const hash = await computeResourceHash(address, resourceConfig, undefined);
		await backend.write(scope, (state) => {
			state.setResource({ address, remote_id: "env_dev", content_hash: hash, desired_hash: hash });
		});

		const run = await syncProjectResourcesWithStateBackend(
			{ projectName: "project-a", config: resourceConfig, stateBackend: backend, stateScope: scope },
			{ refresh: false },
		);

		expect(run.planned.plan.actions.every((action) => action.action === "no-op")).toBe(true);
		expect(run.planned.executionContext.projectName).toBe("project-a");
		expect(replaceResourcePlan(run.planned, run.planned.plan).executionContext).toBe(run.planned.executionContext);
		expect(run.execution?.results).toEqual([]);
		expect(run.execution?.partial).toBe(false);
		expect(backend.getState(scope).resources.map((item) => item.address.name)).toEqual(["dev"]);
	});
});
