import {
	collectProviderCapabilities,
	collectReferenceDiagnostics,
	resolveTargetProviders,
} from "../core/validate-config.ts";
import { DiagnosticCollector } from "../diagnostics/diagnostics.ts";
import { buildDependencyGraph, topologicalSort } from "../graph/dependency.ts";
import type { ProjectConfig } from "../types/config.ts";
import type { ExecutionPlan, PlannedAction } from "../types/plan.ts";
import type { ResourceAddress, StateFile } from "../types/state.ts";
import { addressKey } from "../types/state.ts";
import { getResourceDeclaration } from "./declaration.ts";
import { computeResourceHash } from "./hasher.ts";
import { buildReadinessBaseline, classifyReadinessImpact, diffReadinessBaseline } from "./plan-semantics.ts";

export interface PlanOptions {
	providers?: string[];
	configPath?: string;
}

export async function buildPlan(
	config: ProjectConfig,
	state: StateFile,
	options: PlanOptions = {},
): Promise<ExecutionPlan> {
	const diagnostics = new DiagnosticCollector();
	const actions: PlannedAction[] = [];

	const targetProviders = options.providers ?? resolveTargetProviders(config);
	collectReferenceDiagnostics(config, diagnostics);
	collectProviderCapabilities(config, targetProviders, diagnostics);

	const graph = buildDependencyGraph(config, targetProviders);
	const sorted = topologicalSort(graph);

	const stateIndex = new Map<string, (typeof state.resources)[number]>();
	for (const res of state.resources) {
		stateIndex.set(addressKey(res.address), res);
	}

	// Desired resources: create or update
	for (const address of sorted) {
		const key = addressKey(address);
		const desiredHash = await computeResourceHash(address, config, options.configPath);
		const existing = stateIndex.get(key);
		const deps = getDependencies(address, graph);

		if (!existing) {
			actions.push({
				action: "create",
				address,
				driftKind: "none",
				readinessImpact: "blocking",
				reason: "Resource does not exist in state",
				after: { content_hash: desiredHash },
				dependencies: deps,
			});
		} else if (
			(existing.desired_hash ?? existing.content_hash) !== desiredHash &&
			existing.drift_status === "drifted"
		) {
			const changedPaths = collectChangedPaths(address, config, existing, true);
			actions.push({
				action: "update",
				address,
				driftKind: "both",
				readinessImpact: classifyReadinessImpact("update", changedPaths),
				changedPaths,
				reason: "Local config changed and remote drift detected",
				before: {
					content_hash: existing.desired_hash ?? existing.content_hash,
					remote_hash: existing.remote_hash,
					drift_status: existing.drift_status,
				},
				after: { content_hash: desiredHash },
				dependencies: deps,
			});
		} else if ((existing.desired_hash ?? existing.content_hash) !== desiredHash) {
			const changedPaths = collectChangedPaths(address, config, existing, false);
			actions.push({
				action: "update",
				address,
				driftKind: "local",
				readinessImpact: classifyReadinessImpact("update", changedPaths),
				changedPaths,
				reason: "Local config changed",
				before: { content_hash: existing.desired_hash ?? existing.content_hash },
				after: { content_hash: desiredHash },
				dependencies: deps,
			});
		} else if (existing.drift_status === "drifted") {
			const changedPaths = existing.drift_paths;
			actions.push({
				action: "update",
				address,
				driftKind: "remote",
				readinessImpact: classifyReadinessImpact("update", changedPaths),
				changedPaths,
				reason: "Remote drift detected",
				before: {
					content_hash: existing.desired_hash ?? existing.content_hash,
					remote_hash: existing.remote_hash,
					drift_status: existing.drift_status,
				},
				after: { content_hash: desiredHash },
				dependencies: deps,
			});
		} else {
			actions.push({
				action: "no-op",
				address,
				driftKind: "none",
				readinessImpact: "none",
				reason:
					existing.drift_status === "unchecked"
						? "No changes detected (remote content drift unchecked)"
						: "No changes detected",
				dependencies: deps,
			});
		}

		stateIndex.delete(key);
	}

	// Remaining in state but not in config: delete (reverse order)
	const toDelete = Array.from(stateIndex.values()).reverse();
	for (const res of toDelete) {
		actions.push({
			action: "delete",
			address: res.address,
			driftKind: "none",
			readinessImpact: "blocking",
			reason: "Resource removed from configuration",
			before: { content_hash: res.desired_hash ?? res.content_hash },
			dependencies: [],
		});
	}

	return { actions, diagnostics: diagnostics.getAll() };
}

function collectChangedPaths(
	address: ResourceAddress,
	config: ProjectConfig,
	existing: StateFile["resources"][number],
	includeRemote: boolean,
): string[] | undefined {
	const current = buildReadinessBaseline(getResourceDeclaration(address, config));
	const localPaths = existing.desired_readiness_baseline
		? diffReadinessBaseline(existing.desired_readiness_baseline, current)
		: undefined;
	if (!includeRemote) return localPaths;
	if (!localPaths && !existing.drift_paths) return undefined;
	return [...new Set([...(localPaths ?? []), ...(existing.drift_paths ?? [])])].sort();
}

function getDependencies(address: ResourceAddress, graph: ReturnType<typeof buildDependencyGraph>): ResourceAddress[] {
	const key = addressKey(address);
	const depKeys = graph.edges.get(key) ?? new Set();
	return Array.from(depKeys)
		.map((k) => graph.nodes.get(k))
		.filter((n): n is ResourceAddress => n !== undefined);
}
