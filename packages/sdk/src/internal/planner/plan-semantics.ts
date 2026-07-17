import type { ActionType, PlanReadinessImpact } from "../types/dto.ts";
import type { ResourceReadinessBaseline } from "../types/state.ts";
import { contentHash } from "../utils/hash.ts";

const NON_BLOCKING_ROOT_FIELDS = new Set(["description", "metadata"]);

/**
 * Return stable, leaf-oriented paths whose values differ between two JSON-like
 * resource snapshots. Arrays are treated atomically because their ordering is
 * part of the declared resource semantics.
 */
export function diffChangedPaths(before: unknown, after: unknown, prefix = ""): string[] {
	if (Object.is(before, after)) return [];
	if (Array.isArray(before) || Array.isArray(after)) {
		return structurallyEqual(before, after) ? [] : [prefix || "$root"];
	}
	if (isRecord(before) && isRecord(after)) {
		const paths: string[] = [];
		const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
		for (const key of [...keys].sort()) {
			const path = prefix ? `${prefix}.${key}` : key;
			paths.push(...diffChangedPaths(before[key], after[key], path));
		}
		return paths;
	}
	return [prefix || "$root"];
}

/**
 * Classify whether an already-provisioned Agent Harness can keep running while
 * a planned action is pending. Unknown changes are deliberately blocking.
 */
export function classifyReadinessImpact(
	action: ActionType,
	changedPaths: readonly string[] | undefined,
): PlanReadinessImpact {
	if (action === "no-op") return "none";
	if (action !== "update" || !changedPaths || changedPaths.length === 0) return "blocking";
	return changedPaths.every(isNonBlockingPath) ? "non_blocking" : "blocking";
}

/** Store only irreversible hashes in state; declarations may contain secrets. */
export function buildReadinessBaseline(declaration: unknown): ResourceReadinessBaseline {
	const record = isRecord(declaration) ? declaration : {};
	const { description: _description, metadata: _metadata, ...operational } = record;
	return {
		operational_hash: contentHash(operational),
		description_hash: contentHash(record.description ?? null),
		metadata_hash: contentHash(record.metadata ?? null),
	};
}

export function diffReadinessBaseline(before: ResourceReadinessBaseline, after: ResourceReadinessBaseline): string[] {
	const paths: string[] = [];
	if (before.operational_hash !== after.operational_hash) paths.push("$operational");
	if (before.description_hash !== after.description_hash) paths.push("description");
	if (before.metadata_hash !== after.metadata_hash) paths.push("metadata");
	return paths;
}

function isNonBlockingPath(path: string): boolean {
	const root = path.split(".", 1)[0];
	return root !== undefined && NON_BLOCKING_ROOT_FIELDS.has(root);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function structurallyEqual(left: unknown, right: unknown): boolean {
	return contentHash(left) === contentHash(right);
}
