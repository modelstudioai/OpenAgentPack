import {
	collectProviderCapabilities,
	collectReferenceDiagnostics,
	resolveTargetProviders,
} from "../core/validate-config.ts";
import { DiagnosticCollector } from "../diagnostics/diagnostics.ts";
import { buildDependencyGraph, type DependencyGraph, topologicalSort } from "../graph/dependency.ts";
import { getProvider } from "../providers/registry.ts";
import type { ProjectConfig } from "../types/config.ts";
import type { ExecutionPlan, PlannedAction } from "../types/plan.ts";
import type { ResourceAddress, StateFile } from "../types/state.ts";
import { addressKey } from "../types/state.ts";
import { getResourceDeclaration } from "./declaration.ts";
import { computeReplacementFingerprint, computeResourceHash } from "./hasher.ts";
import { buildReadinessBaseline, classifyReadinessImpact, diffReadinessBaseline } from "./plan-semantics.ts";

export interface PlanOptions {
	providers?: string[];
	configPath?: string;
	resourceAddresses?: readonly ResourceAddress[];
}

export async function buildPlan(
	config: ProjectConfig,
	state: StateFile,
	options: PlanOptions = {},
): Promise<ExecutionPlan> {
	const scopedConfig = options.resourceAddresses ? selectProjectConfig(config, options.resourceAddresses) : config;
	const resourceKeys = options.resourceAddresses ? new Set(options.resourceAddresses.map(addressKey)) : undefined;
	const scopedState = resourceKeys
		? { ...state, resources: state.resources.filter((resource) => resourceKeys.has(addressKey(resource.address))) }
		: state;
	const diagnostics = new DiagnosticCollector();
	const actions: PlannedAction[] = [];

	const targetProviders = options.providers ?? resolveTargetProviders(scopedConfig);
	collectReferenceDiagnostics(scopedConfig, diagnostics);
	collectProviderCapabilities(scopedConfig, targetProviders, diagnostics);

	const graph = buildDependencyGraph(scopedConfig, targetProviders);
	const sorted = topologicalSort(graph);

	const stateIndex = new Map<string, (typeof state.resources)[number]>();
	for (const res of scopedState.resources) {
		stateIndex.set(addressKey(res.address), res);
	}

	// Remote-id lookup that is NOT mutated during the loop (stateIndex entries are
	// deleted as they are consumed), so deployment hashing can always resolve the
	// remote ids of managed reference inputs.
	const remoteIdLookup = new Map<string, (typeof state.resources)[number]>();
	for (const res of scopedState.resources) {
		remoteIdLookup.set(addressKey(res.address), res);
	}
	const hashStateLookup = { getResource: (addr: ResourceAddress) => remoteIdLookup.get(addressKey(addr)) };

	// Desired resources: create or update
	for (const address of sorted) {
		const key = addressKey(address);
		const desiredHash = await computeResourceHash(address, config, options.configPath, hashStateLookup);
		const existing = stateIndex.get(key);
		const deps = getDependencies(address, graph);
		const needsNativeDeploymentMaterialization =
			address.type === "deployment" &&
			existing?.remote_id === null &&
			getProvider(address.provider)?.capabilities.deployment.tier === "native";

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
		if (address.type === "identity" && existing) {
			const identityDecl = config.identities?.[address.name];
			if (existing.externally_managed && identityDecl && !identityDecl.identity_id) {
				diagnostics.error(
					"plan.identity.ownership_transition",
					`identity.${address.name} is recorded as an external reference (${existing.remote_id ?? "unknown id"}); ` +
						`replacing identity_id with a managed declaration would modify and eventually delete an Identity this project does not own. ` +
						`Restore identity_id or release the state reference first.`,
					address,
				);
				stateIndex.delete(key);
				continue;
			}
			if (
				!existing.externally_managed &&
				existing.remote_id &&
				identityDecl?.identity_id &&
				identityDecl.identity_id !== existing.remote_id
			) {
				diagnostics.warning(
					"plan.identity.ownership_orphan",
					`identity.${address.name}: switching to external reference '${identityDecl.identity_id}' orphans the previously ` +
						`managed Identity '${existing.remote_id}'.`,
					address,
				);
			}
		}

		// Reference-only resources are recorded, never mutated remotely — say so.
		const isExternalReference =
			(address.type === "environment" && Boolean(config.environments?.[address.name]?.environment_id)) ||
			(address.type === "identity" && Boolean(config.identities?.[address.name]?.identity_id));
		const createReason = isExternalReference
			? `Record external ${address.type} reference (no remote mutation)`
			: "Resource does not exist in state";
		const updateSuffix = isExternalReference ? " — external reference, no remote mutation" : "";

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
		} else if (needsNativeDeploymentMaterialization) {
			actions.push({
				action: "update",
				address,
				driftKind: "none",
				readinessImpact: "blocking",
				reason: "Materialize legacy state as a native deployment",
				before: { content_hash: existing.desired_hash ?? existing.content_hash },
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

	coalesceChannelRenames(actions, scopedConfig, scopedState);
	return { actions, diagnostics: diagnostics.getAll() };
}

function selectProjectConfig(config: ProjectConfig, addresses: readonly ResourceAddress[]): ProjectConfig {
	const providers = new Set(addresses.map((address) => address.provider));
	const namesByType = new Map<ResourceAddress["type"], Set<string>>();
	for (const address of addresses) {
		const names = namesByType.get(address.type) ?? new Set<string>();
		names.add(address.name);
		namesByType.set(address.type, names);
	}

	const pick = <Declaration>(
		record: Record<string, Declaration> | undefined,
		names: ReadonlySet<string> | undefined,
	): Record<string, Declaration> | undefined => {
		if (!record || !names?.size) return undefined;
		const selected = Object.fromEntries(Object.entries(record).filter(([name]) => names.has(name)));
		return Object.keys(selected).length > 0 ? selected : undefined;
	};
	const agentNames = new Set([...(namesByType.get("agent") ?? []), ...(namesByType.get("template") ?? [])]);
	const selectedAgents = pick(config.agents, agentNames);
	const tunnelNames = new Set<string>();
	for (const agent of Object.values(selectedAgents ?? {})) {
		if (agent.tunnel) tunnelNames.add(agent.tunnel);
	}
	for (const deployment of Object.values(pick(config.deployments, namesByType.get("deployment")) ?? {})) {
		if (deployment.tunnel) tunnelNames.add(deployment.tunnel);
	}
	const identityNames = namesByType.get("identity");
	const selectedProviders = Object.fromEntries(
		Object.entries(config.providers).filter(([providerName]) => providers.has(providerName)),
	);
	const defaultProvider = providers.size === 1 ? [...providers][0] : config.defaults?.provider;
	const defaultIdentity =
		config.defaults?.identity && identityNames?.has(config.defaults.identity) ? config.defaults.identity : undefined;

	return {
		...config,
		providers: selectedProviders,
		defaults: defaultProvider || defaultIdentity ? { provider: defaultProvider, identity: defaultIdentity } : undefined,
		environments: pick(config.environments, namesByType.get("environment")),
		tunnels: pick(config.tunnels, tunnelNames),
		vaults: pick(config.vaults, namesByType.get("vault")),
		memory_stores: pick(config.memory_stores, namesByType.get("memory_store")),
		skills: pick(config.skills, namesByType.get("skill")),
		files: pick(config.files, namesByType.get("file")),
		identities: pick(config.identities, identityNames),
		agents: selectedAgents,
		channels: pick(config.channels, namesByType.get("channel")),
		deployments: pick(config.deployments, namesByType.get("deployment")),
	};
}

/**
 * A YAML key is a resource address, but changing that key should not force a
 * remote Channel replacement when the old and new declarations form one
 * unambiguous same-type pair. Retaining the remote id is especially important
 * for messaging providers that allow a credential set to belong to only one
 * Channel at a time.
 */
function coalesceChannelRenames(actions: PlannedAction[], config: ProjectConfig, state: StateFile): void {
	const creates = actions.filter((action) => action.action === "create" && action.address.type === "channel");
	const deletes = actions.filter((action) => action.action === "delete" && action.address.type === "channel");
	const stateByAddress = new Map(state.resources.map((resource) => [addressKey(resource.address), resource]));
	const matchedDeletes = new Set<PlannedAction>();

	for (const create of creates) {
		const desiredType = config.channels?.[create.address.name]?.type;
		if (!desiredType) continue;
		const desiredFingerprint = computeReplacementFingerprint(create.address, config);
		const candidates = deletes.filter((deletion) => {
			if (matchedDeletes.has(deletion) || deletion.address.provider !== create.address.provider) return false;
			const prior = stateByAddress.get(addressKey(deletion.address));
			const snapshot = prior?.remote_snapshot as { channel_type?: unknown } | undefined;
			if (snapshot?.channel_type !== desiredType) return false;
			return !prior?.replacement_fingerprint || prior.replacement_fingerprint === desiredFingerprint;
		});
		if (candidates.length !== 1) continue;

		const deletion = candidates[0]!;
		const prior = stateByAddress.get(addressKey(deletion.address));
		const competingCreates = creates.filter(
			(candidate) =>
				candidate !== create &&
				candidate.address.provider === create.address.provider &&
				config.channels?.[candidate.address.name]?.type === desiredType &&
				(!prior?.replacement_fingerprint ||
					computeReplacementFingerprint(candidate.address, config) === prior.replacement_fingerprint),
		);
		if (competingCreates.length > 0) continue;

		create.action = "update";
		create.previousAddress = deletion.address;
		create.before = deletion.before;
		create.driftKind = "local";
		create.reason = `Channel key renamed from '${deletion.address.name}' (remote resource retained)`;
		protectRenamedChannelDependencies(actions, stateByAddress, deletion, create);
		matchedDeletes.add(deletion);
	}

	for (let index = actions.length - 1; index >= 0; index--) {
		if (matchedDeletes.has(actions[index]!)) actions.splice(index, 1);
	}
}

/** Do not delete the old Identity/Template when the Channel migration that releases it fails. */
function protectRenamedChannelDependencies(
	actions: PlannedAction[],
	stateByAddress: Map<string, StateFile["resources"][number]>,
	deletion: PlannedAction,
	replacement: PlannedAction,
): void {
	const prior = stateByAddress.get(addressKey(deletion.address));
	const snapshot = prior?.remote_snapshot as { identity_id?: unknown; template_id?: unknown } | undefined;
	const referencedIds = new Set(
		[snapshot?.identity_id, snapshot?.template_id].filter((id): id is string => typeof id === "string"),
	);
	if (referencedIds.size === 0) return;

	for (const action of actions) {
		if (
			action.action !== "delete" ||
			(action.address.type !== "identity" && action.address.type !== "template") ||
			action.address.provider !== replacement.address.provider
		) {
			continue;
		}
		const dependency = stateByAddress.get(addressKey(action.address));
		if (!dependency?.remote_id || !referencedIds.has(dependency.remote_id)) continue;
		if (!action.dependencies.some((address) => addressKey(address) === addressKey(replacement.address))) {
			action.dependencies.push(replacement.address);
		}
	}
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
