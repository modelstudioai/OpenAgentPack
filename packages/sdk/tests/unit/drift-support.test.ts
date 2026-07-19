import { describe, expect, test } from "bun:test";
import { readComparableIfSupported } from "../../src/internal/providers/drift-support.ts";
import type { ComparableRemoteResource } from "../../src/internal/providers/interface.ts";
import type { DriftReadAdapter } from "../../src/internal/providers/resource-workflow.ts";
import type { ResourceType } from "../../src/internal/types/state.ts";

// Regression: readComparableIfSupported must invoke readComparableResource as a
// method on the adapter. Extracting it into a local drops `this`, so class-based
// adapters (qoder, bailian) silently returned null and the post-apply drift
// baseline fell back to the desired hash — producing phantom "Remote drift
// detected" on every subsequent plan.
class ClassBasedAdapter {
	readonly name = "classy";
	private readonly comparable = { config: { type: "cloud" } };

	getDriftSupport(type: ResourceType): "full" | "unsupported" {
		return type === "environment" ? "full" : "unsupported";
	}

	async readComparableResource(type: ResourceType, id: string | null): Promise<ComparableRemoteResource | null> {
		// Touch `this` like the real class adapters do (this.client, ...).
		return { id: id ?? "env_1", type, comparable: this.comparable, snapshot: this.comparable };
	}
}

describe("readComparableIfSupported", () => {
	test("works with class-based adapters whose methods rely on `this`", async () => {
		const adapter = new ClassBasedAdapter() as unknown as DriftReadAdapter;
		const remote = await readComparableIfSupported(adapter, "environment", "env_1", "any");
		expect(remote?.id).toBe("env_1");
	});

	test("returns null when drift is unsupported for the resource type", async () => {
		const adapter = new ClassBasedAdapter() as unknown as DriftReadAdapter;
		const remote = await readComparableIfSupported(adapter, "vault", "vault_1", "any");
		expect(remote).toBeNull();
	});
});
