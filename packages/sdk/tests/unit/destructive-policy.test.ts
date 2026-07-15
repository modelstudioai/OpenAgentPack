import { describe, expect, test } from "bun:test";
import { decideDestructive, syncProjectResourcesWithStateBackend } from "../../src/index.ts";
import { planProjectWithStateBackend } from "../../src/internal/core/resource-runtime.ts";
import type { StateScope } from "../../src/internal/state/backend.ts";
import { InMemoryStateBackend } from "../../src/internal/state/in-memory-state-backend.ts";
import type { ResolvedProjectConfig } from "../../src/internal/types/config.ts";
import type { PlannedAction } from "../../src/internal/types/dto.ts";
import type { ResourceState } from "../../src/internal/types/state.ts";

function destroy(name: string): PlannedAction {
	return {
		action: "delete",
		address: { provider: "qoder", type: "agent", name },
		reason: "Resource removed from configuration",
		dependencies: [],
	};
}

describe("decideDestructive", () => {
	test("no destructive actions proceeds regardless of policy", async () => {
		expect(await decideDestructive([], { policy: "block" })).toBe("proceed");
		expect(await decideDestructive([], { policy: "prompt" })).toBe("proceed");
		expect(await decideDestructive([], {})).toBe("proceed");
	});

	test("block (the default) refuses destructive actions", async () => {
		expect(await decideDestructive([destroy("a")], { policy: "block" })).toBe("blocked");
		expect(await decideDestructive([destroy("a")], {})).toBe("blocked");
	});

	test("force proceeds without consulting a callback", async () => {
		let consulted = false;
		const decision = await decideDestructive([destroy("a")], {
			policy: "force",
			confirm: () => {
				consulted = true;
				return false;
			},
		});
		expect(decision).toBe("proceed");
		expect(consulted).toBe(false);
	});

	test("prompt defers to the callback: approval proceeds", async () => {
		const actions = [destroy("a"), destroy("b")];
		let received: PlannedAction[] | undefined;
		const decision = await decideDestructive(actions, {
			policy: "prompt",
			confirm: (acts) => {
				received = acts;
				return true;
			},
		});
		expect(decision).toBe("proceed");
		expect(received).toBe(actions);
	});

	test("prompt defers to the callback: rejection cancels", async () => {
		const decision = await decideDestructive([destroy("a")], {
			policy: "prompt",
			confirm: () => false,
		});
		expect(decision).toBe("cancelled");
	});

	test("prompt without a callback cannot confirm, so it blocks", async () => {
		expect(await decideDestructive([destroy("a")], { policy: "prompt" })).toBe("blocked");
	});

	test("awaits an async callback", async () => {
		const decision = await decideDestructive([destroy("a")], {
			policy: "prompt",
			confirm: async () => true,
		});
		expect(decision).toBe("proceed");
	});
});

describe("project destructive policy", () => {
	const scope: StateScope = { projectId: "project-a", namespace: "default" };
	const config: ResolvedProjectConfig = {
		version: "1",
		providers: { qoder: { api_key: "test" } },
		defaults: { provider: "qoder" },
		_resolved: true,
	};
	const removedResource: ResourceState = {
		address: { provider: "qoder", type: "agent", name: "old-agent" },
		remote_id: "agent_old",
		content_hash: "old_hash",
	};

	test("state-managed project sync blocks destructive plans by default before mutating state", async () => {
		const backend = new InMemoryStateBackend();
		await backend.write(scope, (state) => {
			state.setResource(removedResource);
		});
		const input = { projectName: "project-a", config, stateBackend: backend, stateScope: scope };

		const planned = await planProjectWithStateBackend(input, { refresh: false });
		expect(planned.destructiveActions.map((action) => action.address.name)).toEqual(["old-agent"]);

		await expect(syncProjectResourcesWithStateBackend(input, { refresh: false })).rejects.toThrow(/will not delete/);
		expect(backend.getState(scope).resources).toEqual([removedResource]);
	});
});
