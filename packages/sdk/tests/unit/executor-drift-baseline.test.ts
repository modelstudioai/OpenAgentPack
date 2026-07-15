import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecContext } from "../../src/internal/executor/context.ts";
import { executePlan } from "../../src/internal/executor/executor.ts";
import type {
	ComparableRemoteResource,
	DriftSupport,
	ProviderAdapter,
	RemoteResource,
} from "../../src/internal/providers/interface.ts";
import { StateManager } from "../../src/internal/state/state-manager.ts";
import type { ProjectConfig } from "../../src/internal/types/config.ts";
import type { ExecutionPlan } from "../../src/internal/types/plan.ts";
import type { ResourceType } from "../../src/internal/types/state.ts";
import { contentHash } from "../../src/internal/utils/hash.ts";
import "../../src/internal/providers/all.ts";

function tmpPath(): string {
	return join(tmpdir(), `exec-drift-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
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

/**
 * Simulates the common cloud API behavior: the API returns enriched/modified
 * versions of what you sent (e.g., extra fields, normalized values).
 */
function fakeProvider(opts: { remoteComparable: unknown; desiredComparable: unknown }): ProviderAdapter {
	return {
		name: "bailian",
		validate: async () => {},
		findResource: async () => ({ id: "env_1", type: "environment" }),
		getDriftSupport: (type: ResourceType): DriftSupport => (type === "environment" ? "full" : "unsupported"),
		readComparableResource: async (
			_type: ResourceType,
			_id: string | null,
			_name: string,
		): Promise<ComparableRemoteResource | null> => {
			return {
				id: "env_1",
				type: "environment",
				version: 1,
				comparable: opts.remoteComparable,
				snapshot: opts.remoteComparable,
			};
		},
		normalizeDesiredResource: () => opts.desiredComparable,
		createEnvironment: async (): Promise<RemoteResource> => ({ id: "env_1", type: "environment", version: 1 }),
		updateEnvironment: async (): Promise<RemoteResource> => ({ id: "env_1", type: "environment", version: 2 }),
		deleteEnvironment: async () => {},
	} as unknown as ProviderAdapter;
}

describe("executor drift baseline (post-apply read-back)", () => {
	test("saves actual remote hash as baseline after apply, not desired hash", async () => {
		// Simulate: desired normalization produces { description: "Test env" }
		// but the API returns { description: "Test env", url: "https://..." }
		const desiredComparable = { description: "Test env" };
		const remoteComparable = { description: "Test env", url: "https://added-by-server" };

		const provider = fakeProvider({ remoteComparable, desiredComparable });
		const state = StateManager.initialize(tmpPath());

		const plan: ExecutionPlan = {
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

		const ctx: ExecContext = {
			config,
			configPath: "/tmp/agents.yaml",
			providers: new Map([["bailian", provider]]),
			state,
		};

		await executePlan(plan, ctx);

		const saved = state.getResource({ type: "environment", name: "my-env", provider: "bailian" })!;

		// The baseline should be the ACTUAL remote hash, not the desired hash
		const expectedRemoteHash = contentHash(remoteComparable);
		const desiredHash = contentHash(desiredComparable);

		expect(saved.drift_status).toBe("in_sync");
		expect(saved.desired_comparable_hash).toBe(expectedRemoteHash);
		expect(saved.remote_hash).toBe(expectedRemoteHash);
		// It should NOT be the desired hash (which would cause false drift on next plan)
		expect(saved.desired_comparable_hash).not.toBe(desiredHash);
	});

	test("falls back to desired hash when read-back fails", async () => {
		const desiredComparable = { description: "Test env" };

		// Provider that throws on readComparableResource
		const provider = {
			name: "bailian",
			validate: async () => {},
			findResource: async () => ({ id: "env_1", type: "environment" }),
			getDriftSupport: (type: ResourceType): DriftSupport => (type === "environment" ? "full" : "unsupported"),
			readComparableResource: async (): Promise<ComparableRemoteResource | null> => {
				throw new Error("API temporarily unavailable");
			},
			normalizeDesiredResource: () => desiredComparable,
			createEnvironment: async (): Promise<RemoteResource> => ({ id: "env_1", type: "environment", version: 1 }),
		} as unknown as ProviderAdapter;

		const state = StateManager.initialize(tmpPath());

		const plan: ExecutionPlan = {
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

		const ctx: ExecContext = {
			config,
			configPath: "/tmp/agents.yaml",
			providers: new Map([["bailian", provider]]),
			state,
		};

		await executePlan(plan, ctx);

		const saved = state.getResource({ type: "environment", name: "my-env", provider: "bailian" })!;
		// Falls back to desired hash
		expect(saved.drift_status).toBe("in_sync");
		expect(saved.desired_comparable_hash).toBe(contentHash(desiredComparable));
	});

	test("no false drift on subsequent refresh when API enriches payloads", async () => {
		// This is the full integration scenario:
		// 1. Apply creates a resource
		// 2. API returns enriched payload (extra fields)
		// 3. State baseline is set from actual remote
		// 4. Next refresh reads the same remote → hashes match → no drift
		const desiredComparable = { description: "Test env" };
		const remoteComparable = { description: "Test env", url: "https://added-by-server" };

		const provider = fakeProvider({ remoteComparable, desiredComparable });
		const state = StateManager.initialize(tmpPath());

		// Step 1: Apply
		const plan: ExecutionPlan = {
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

		await executePlan(plan, {
			config,
			configPath: "/tmp/agents.yaml",
			providers: new Map([["bailian", provider]]),
			state,
		});

		// Step 2: Simulate next refresh (same logic as refresh.ts)
		const saved = state.getResource({ type: "environment", name: "my-env", provider: "bailian" })!;
		const remoteHash = contentHash(remoteComparable);
		const baselineHash = saved.desired_comparable_hash;

		// The baseline should match the remote → no drift!
		expect(remoteHash).toBe(baselineHash!);
		expect(saved.drift_status).toBe("in_sync");
	});
});
