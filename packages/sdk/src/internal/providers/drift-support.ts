import type { ResourceType } from "../types/state.ts";
import type { ComparableRemoteResource } from "./interface.ts";
import type { DriftReadAdapter } from "./resource-workflow.ts";

/**
 * Whether the adapter can read full comparable remote state for a resource type.
 * Centralizes the `getDriftSupport === "full" && readComparableResource` check
 * that the executor and planner/refresh would otherwise each spell out.
 */
export function supportsFullDrift(adapter: DriftReadAdapter, type: ResourceType): boolean {
	return adapter.getDriftSupport?.(type) === "full" && typeof adapter.readComparableResource === "function";
}

/**
 * Read comparable remote state when the adapter supports full drift for the type;
 * returns null when unsupported or on a best-effort read failure. Callers no longer
 * branch on capability presence — the seam owns it.
 */
export async function readComparableIfSupported(
	adapter: DriftReadAdapter,
	type: ResourceType,
	id: string | null,
	name: string,
): Promise<ComparableRemoteResource | null> {
	const read = adapter.readComparableResource;
	if (typeof read !== "function" || !supportsFullDrift(adapter, type)) return null;
	try {
		return await read(type, id, name);
	} catch {
		return null;
	}
}
