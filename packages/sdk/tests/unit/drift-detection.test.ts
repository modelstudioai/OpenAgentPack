import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildReadinessBaseline } from "../../src/internal/planner/plan-semantics.ts";
import { buildPlan } from "../../src/internal/planner/planner.ts";
import { refreshState } from "../../src/internal/planner/refresh.ts";
import type {
	ComparableRemoteResource,
	DriftSupport,
	ProviderAdapter,
} from "../../src/internal/providers/interface.ts";
import { QoderAdapter } from "../../src/internal/providers/qoder/adapter.ts";
import { StateManager } from "../../src/internal/state/state-manager.ts";
import type { ProjectConfig } from "../../src/internal/types/config.ts";
import type { ResourceType } from "../../src/internal/types/state.ts";
import { contentHash } from "../../src/internal/utils/hash.ts";
import "../../src/internal/providers/qoder/index.ts";

function tmpPath(): string {
	return join(tmpdir(), `drift-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

const config: ProjectConfig = {
	version: "1",
	providers: { qoder: { api_key: "test" } },
	defaults: { provider: "qoder" },
	agents: {
		assistant: {
			description: "original",
			model: "ultimate",
			instructions: "original instructions",
		},
	},
};

function fakeProvider(remoteComparable: unknown | null): ProviderAdapter {
	return {
		name: "qoder",
		validate: async () => {},
		findResource: async () => (remoteComparable === null ? null : { id: "agent_1", type: "agent", version: 2 }),
		getDriftSupport: (type: ResourceType): DriftSupport => (type === "agent" ? "full" : "unsupported"),
		readComparableResource: async (): Promise<ComparableRemoteResource | null> => {
			if (remoteComparable === null) return null;
			return {
				id: "agent_1",
				type: "agent",
				version: 2,
				comparable: remoteComparable,
				snapshot: remoteComparable,
			};
		},
		normalizeDesiredResource: (_type: ResourceType, _name: string, decl: unknown) => decl,
	} as unknown as ProviderAdapter;
}

describe("drift-aware refresh", () => {
	test("records drift when comparable remote content differs from baseline", async () => {
		const path = tmpPath();
		const state = StateManager.initialize(path);
		const desired = config.agents!.assistant!;
		const desiredHash = contentHash(desired);
		state.setResource({
			address: { type: "agent", name: "assistant", provider: "qoder" },
			remote_id: "agent_1",
			content_hash: "yaml_hash",
			desired_hash: "yaml_hash",
			desired_comparable_hash: desiredHash,
		});

		await refreshState(state, new Map([["qoder", fakeProvider({ ...desired, description: "remote drift" })]]), {
			config,
		});

		const refreshed = state.getResource({ type: "agent", name: "assistant", provider: "qoder" })!;
		expect(refreshed.drift_status).toBe("drifted");
		expect(refreshed.remote_hash).toBe(contentHash({ ...desired, description: "remote drift" }));
		expect(refreshed.drift_paths).toEqual(["description"]);
	});

	test("keeps provider scoping during refresh", async () => {
		const state = StateManager.initialize(tmpPath());
		state.setResource({
			address: { type: "agent", name: "assistant", provider: "qoder" },
			remote_id: "agent_1",
			content_hash: "h",
			desired_hash: "h",
		});

		await refreshState(state, new Map([["qoder", fakeProvider(null)]]), { targetProviders: ["claude"], config });

		expect(state.getResource({ type: "agent", name: "assistant", provider: "qoder" })).toBeDefined();
	});
});

describe("Qoder comparable fixtures", () => {
	test("normalizes sanitized live payloads to Agents-owned comparable fields", async () => {
		const fixtures = resolve(import.meta.dir, "../fixtures");
		const agentPayload = await Bun.file(join(fixtures, "qoder-drift-agent.json")).json();
		const envPayload = await Bun.file(join(fixtures, "qoder-drift-environment.json")).json();
		const adapter = new QoderAdapter("pt-test", undefined, "tmp") as any;

		expect(adapter.normalizeRemote("agent", agentPayload)).toEqual({
			description: "Agents live drift original agent",
			model: "ultimate",
			instructions: "You are a temporary Agents live drift validation agent. Reply with original.\n",
			tools: { builtin: ["read"] },
			metadata: { cma_test: "drift-validation" },
		});

		expect(adapter.normalizeRemote("environment", envPayload)).toEqual({
			description: "Agents live drift original environment",
			config: {
				type: "cloud",
				networking: { type: "unrestricted" },
			},
			metadata: { cma_test: "drift-validation" },
		});
	});
});

describe("planner drift classification", () => {
	test("marks remote description-only drift as non-blocking without consulting reason text", async () => {
		const desired = config.agents!.assistant!;
		const desiredHash = contentHash(desired);
		const state = StateManager.initialize(tmpPath());
		state.setResource({
			address: { type: "agent", name: "assistant", provider: "qoder" },
			remote_id: "agent_1",
			content_hash: desiredHash,
			desired_hash: desiredHash,
			desired_comparable_hash: desiredHash,
			desired_readiness_baseline: buildReadinessBaseline(desired),
		});

		await refreshState(state, new Map([["qoder", fakeProvider({ ...desired, description: "remote drift" })]]), {
			config,
		});
		const plan = await buildPlan(config, state.getStateFile());

		expect(plan.actions[0]).toMatchObject({
			action: "update",
			driftKind: "remote",
			readinessImpact: "non_blocking",
			changedPaths: ["description"],
		});
	});

	test("keeps runtime-affecting remote drift blocking", async () => {
		const desired = config.agents!.assistant!;
		const desiredHash = contentHash(desired);
		const state = StateManager.initialize(tmpPath());
		state.setResource({
			address: { type: "agent", name: "assistant", provider: "qoder" },
			remote_id: "agent_1",
			content_hash: desiredHash,
			desired_hash: desiredHash,
			desired_comparable_hash: desiredHash,
			desired_readiness_baseline: buildReadinessBaseline(desired),
		});

		await refreshState(state, new Map([["qoder", fakeProvider({ ...desired, model: "different" })]]), { config });
		const plan = await buildPlan(config, state.getStateFile());

		expect(plan.actions[0]).toMatchObject({
			action: "update",
			readinessImpact: "blocking",
			changedPaths: ["model"],
		});
	});

	test("marks a local description-only change as non-blocking when the state has a readiness baseline", async () => {
		const previous = { ...config.agents!.assistant!, description: "previous" };
		const plan = await buildPlan(config, {
			resources: [
				{
					address: { type: "agent", name: "assistant", provider: "qoder" },
					remote_id: "agent_1",
					content_hash: contentHash(previous),
					desired_hash: contentHash(previous),
					desired_readiness_baseline: buildReadinessBaseline(previous),
					drift_status: "in_sync",
				},
			],
		});

		expect(plan.actions[0]).toMatchObject({
			action: "update",
			driftKind: "local",
			readinessImpact: "non_blocking",
			changedPaths: ["description"],
		});
	});

	test("plans update for remote drift without local yaml changes", async () => {
		const desiredHash = contentHash(config.agents!.assistant!);
		const plan = await buildPlan(config, {
			resources: [
				{
					address: { type: "agent", name: "assistant", provider: "qoder" },
					remote_id: "agent_1",
					content_hash: desiredHash,
					desired_hash: desiredHash,
					drift_status: "drifted",
					remote_hash: "remote_hash",
				},
			],
		});

		expect(plan.actions).toHaveLength(1);
		expect(plan.actions[0]!.action).toBe("update");
		expect(plan.actions[0]!.driftKind).toBe("remote");
		expect(plan.actions[0]!.reason).toBe("Remote drift detected");
	});

	test("distinguishes local config changes from combined local and remote drift", async () => {
		const plan = await buildPlan(config, {
			resources: [
				{
					address: { type: "agent", name: "assistant", provider: "qoder" },
					remote_id: "agent_1",
					content_hash: "old_yaml_hash",
					desired_hash: "old_yaml_hash",
					drift_status: "drifted",
					remote_hash: "remote_hash",
				},
			],
		});

		expect(plan.actions[0]!.action).toBe("update");
		expect(plan.actions[0]!.driftKind).toBe("both");
		expect(plan.actions[0]!.reason).toBe("Local config changed and remote drift detected");
	});
});

describe("Qoder archived resources are treated as gone", () => {
	function adapterWith(getImpl: (path: string) => Promise<unknown>, paged: Record<string, unknown>[] = []) {
		const adapter = new QoderAdapter("pt-test", undefined, "tmp") as any;
		adapter.client = { get: getImpl, getAllPaged: async () => paged };
		return adapter;
	}

	test("readComparableResource returns null for an archived agent", async () => {
		const adapter = adapterWith(async () => ({
			id: "agent_1",
			name: "a",
			archived_at: "2026-07-19T00:00:00Z",
		}));
		expect(await adapter.readComparableResource("agent", "agent_1", "a")).toBeNull();
	});

	test("findResource returns null for an archived resource, found when active", async () => {
		const archived = adapterWith(async () => ({
			id: "env_1",
			name: "e",
			archived_at: "2026-07-19T00:00:00Z",
		}));
		expect(await archived.findResource("environment", "e", "env_1")).toBeNull();

		const active = adapterWith(async () => ({ id: "env_1", name: "e", archived_at: null }));
		expect((await active.findResource("environment", "e", "env_1"))?.id).toBe("env_1");
	});

	test("name scan skips archived entries and matches active ones", async () => {
		const adapter = adapterWith(async () => {
			throw new Error("id path must not be used");
		}, [
			{ id: "agent_archived", name: "a", archived_at: "2026-07-19T00:00:00Z" },
			{ id: "agent_active", name: "a", archived_at: null },
		]);
		expect((await adapter.findResource("agent", "a"))?.id).toBe("agent_active");
	});
});
