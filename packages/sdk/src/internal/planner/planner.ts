import {
	collectProviderCapabilities,
	collectReferenceDiagnostics,
	resolveTargetProviders,
} from "../core/validate-config.ts";
import { DiagnosticCollector } from "../diagnostics/diagnostics.ts";
import { buildDependencyGraph, type DependencyGraph, topologicalSort } from "../graph/dependency.ts";
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

	// Remote-id lookup that is NOT mutated during the loop (stateIndex entries are
	// deleted as they are consumed), so deployment hashing can always resolve the
	// remote ids of managed reference inputs.
	const remoteIdLookup = new Map<string, (typeof state.resources)[number]>();
	for (const res of state.resources) {
		remoteIdLookup.set(addressKey(res.address), res);
	}
	const hashStateLookup = { getResource: (addr: ResourceAddress) => remoteIdLookup.get(addressKey(addr)) };

	// Desired resources: create or update
	for (const address of sorted) {
		const key = addressKey(address);
		const desiredHash = await computeResourceHash(address, config, options.configPath, hashStateLookup);
		const existing = stateIndex.get(key);
		const deps = getDependencies(address, graph);

		if (address.type === "environment" && existing) {
			const envDecl = config.environments?.[address.name];
			// Ownership is a state-level fact: once an environment is recorded as
			// externally managed, removing `environment_id` from the config must NOT
			// silently convert it back into a managed resource (apply would push the
			// local config onto a remote object OpenCMA never created, and destroy
			// would delete it). Require an explicit release instead.
			if (existing.externally_managed && envDecl && !envDecl.environment_id) {
				diagnostics.error(
					"plan.environment.ownership_transition",
					`environment.${address.name} is recorded as an external reference (${existing.remote_id ?? "unknown id"}); ` +
						`removing 'environment_id' would make OpenCMA modify and eventually delete a remote environment it does not own. ` +
						`Restore 'environment_id' to keep it as a reference, or release it first with 'agents state rm environment.${address.name}' ` +
						`(then 'agents state import' to adopt the remote as a managed resource).`,
					address,
				);
				stateIndex.delete(key);
				continue;
			}
			if (
				!existing.externally_managed &&
				existing.remote_id &&
				envDecl?.environment_id &&
				envDecl.environment_id !== existing.remote_id
			) {
				diagnostics.warning(
					"plan.environment.ownership_orphan",
					`environment.${address.name}: switching to external reference '${envDecl.environment_id}' orphans the previously ` +
						`managed remote environment '${existing.remote_id}' — it will no longer be tracked or deletable by OpenCMA.`,
					address,
				);
			}
		}

		// Reference-only environments are recorded, never mutated remotely — say so.
		const isExternalEnv =
			address.type === "environment" && Boolean(config.environments?.[address.name]?.environment_id);
		const createReason = isExternalEnv
			? "Record external environment reference (no remote mutation)"
			: "Resource does not exist in state";
		const updateSuffix = isExternalEnv ? " — external reference, no remote mutation" : "";

		if (!existing) {
			actions.push({
				action: "create",
				address,
				driftKind: "none",
				readinessImpact: "blocking",
				reason: createReason,
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
				reason: `Local config changed and remote drift detected${updateSuffix}`,
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
				reason: `Local config changed${updateSuffix}`,
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
				reason: `Remote drift detected${updateSuffix}`,
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
		const replacement = deliveryReplacementAddress(res.address, graph);
		actions.push({
			action: "delete",
			address: res.address,
			driftKind: "none",
			readinessImpact: "blocking",
			reason: res.externally_managed
				? "Remove local reference only — externally managed remote resource is left intact"
				: "Resource removed from configuration",
			before: { content_hash: res.desired_hash ?? res.content_hash },
			dependencies: replacement ? [replacement] : [],
		});
	}

	return { actions, diagnostics: diagnostics.getAll() };
}

/** Keep the old delivery resource alive when creating its new materialization fails. */
function deliveryReplacementAddress(address: ResourceAddress, graph: DependencyGraph): ResourceAddress | undefined {
	if (address.type !== "agent" && address.type !== "template") return undefined;
	const replacementType = address.type === "agent" ? "template" : "agent";
	const candidate: ResourceAddress = { ...address, type: replacementType };
	return graph.nodes.has(addressKey(candidate)) ? candidate : undefined;
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
