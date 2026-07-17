import { supportsFullDrift } from "../providers/drift-support.ts";
import type { DriftReadAdapter, ResourceCrudAdapter } from "../providers/resource-workflow.ts";
import type { IStateManager } from "../state/state-manager.ts";
import type { ProjectConfig } from "../types/config.ts";
import { emitRuntimeFeedback, type RuntimeFeedbackSink } from "../types/runtime-feedback.ts";
import type { ResourceState } from "../types/state.ts";
import { contentHash } from "../utils/hash.ts";
import { getResourceDeclaration } from "./declaration.ts";
import { diffChangedPaths } from "./plan-semantics.ts";

export interface RefreshResult {
	removed: ResourceState[];
	errors: Array<{ resource: ResourceState; error: Error }>;
}

/**
 * Refresh local state against remote providers.
 *
 * For each resource tracked in state, queries the remote provider to verify
 * the resource still exists. If not found, removes it from state so the
 * planner will generate a "create" action.
 *
 * This implements "plan-time refresh" — the same concept as Terraform's
 * implicit refresh during plan/apply.
 */
export async function refreshState(
	state: IStateManager,
	providers: ReadonlyMap<string, DriftReadAdapter & Pick<ResourceCrudAdapter, "findResource">>,
	options: {
		targetProviders?: string[];
		config?: ProjectConfig;
		quiet?: boolean;
		onFeedback?: RuntimeFeedbackSink;
	} = {},
): Promise<RefreshResult> {
	const resources = state.listResources();
	const removed: ResourceState[] = [];
	const errors: Array<{ resource: ResourceState; error: Error }> = [];
	let dirty = false;

	for (const res of resources) {
		// Skip resources from providers not in scope
		if (options.targetProviders && !options.targetProviders.includes(res.address.provider)) {
			continue;
		}

		const provider = providers.get(res.address.provider);
		if (!provider) continue;

		try {
			// Three drift tiers: "full" compares content hash, "existence" only checks presence, "unsupported" skips entirely.
			const support = provider.getDriftSupport?.(res.address.type) ?? "existence";

			if (supportsFullDrift(provider, res.address.type) && provider.normalizeDesiredResource) {
				const remote = await provider.readComparableResource?.(res.address.type, res.remote_id, res.address.name);
				if (!remote) {
					if (!options.quiet) {
						emitRuntimeFeedback(options.onFeedback, {
							type: "refresh_resource_missing",
							level: "warning",
							resource: res.address,
							message: `${res.address.type}.${res.address.name} (${res.address.provider}) — not found remotely, will recreate`,
						});
					}
					state.removeResource(res.address);
					removed.push(res);
					dirty = true;
					continue;
				}

				const remoteHash = contentHash(remote.comparable);
				const decl = options.config ? getResourceDeclaration(res.address, options.config) : null;
				const desiredComparable = decl
					? provider.normalizeDesiredResource(res.address.type, res.address.name, decl)
					: null;
				const desiredComparableHash = desiredComparable === null ? undefined : contentHash(desiredComparable);
				const baselineHash = res.desired_comparable_hash ?? desiredComparableHash;
				const driftStatus = baselineHash && remoteHash !== baselineHash ? "drifted" : "in_sync";
				const driftPaths =
					driftStatus === "drifted" && desiredComparable !== null
						? diffChangedPaths(desiredComparable, remote.comparable)
						: [];

				state.setResource({
					...res,
					version: remote.version ?? res.version,
					remote_id: remote.id,
					desired_hash: res.desired_hash ?? res.content_hash,
					desired_comparable_hash: res.desired_comparable_hash ?? desiredComparableHash,
					remote_hash: remoteHash,
					remote_snapshot: remote.snapshot ?? remote.comparable,
					drift_paths: driftPaths,
					drift_status: driftStatus,
				});
				dirty = true;
				continue;
			}

			if (support === "unsupported") {
				if (!options.quiet) {
					emitRuntimeFeedback(options.onFeedback, {
						type: "refresh_drift_unchecked",
						level: "warning",
						resource: res.address,
						message: `Content drift not checked for ${res.address.type}.${res.address.name} (${res.address.provider}): unsupported`,
					});
				}
				state.setResource({
					...res,
					desired_hash: res.desired_hash ?? res.content_hash,
					drift_status: "unchecked",
				});
				dirty = true;
				continue;
			}

			// Prefer the recorded remote_id so existence checks hit the detail
			// endpoint (GET /{id}) instead of matching by name — names are not
			// guaranteed unique, so name matching can adopt the wrong resource.
			const remote = await provider.findResource(res.address.type, res.address.name, res.remote_id);
			if (!remote) {
				if (!options.quiet) {
					emitRuntimeFeedback(options.onFeedback, {
						type: "refresh_resource_missing",
						level: "warning",
						resource: res.address,
						message: `${res.address.type}.${res.address.name} (${res.address.provider}) — not found remotely, will recreate`,
					});
				}
				state.removeResource(res.address);
				removed.push(res);
				dirty = true;
			} else {
				if (!options.quiet) {
					emitRuntimeFeedback(options.onFeedback, {
						type: "refresh_drift_unchecked",
						level: "warning",
						resource: res.address,
						message: `Content drift not checked for ${res.address.type}.${res.address.name} (${res.address.provider}): existence-only`,
					});
				}
				state.setResource({
					...res,
					version: remote.version ?? res.version,
					remote_id: remote.id,
					desired_hash: res.desired_hash ?? res.content_hash,
					drift_status: "unchecked",
				});
				dirty = true;
			}
		} catch (err) {
			// Don't fail refresh on API errors — degrade gracefully
			const error = err instanceof Error ? err : new Error(String(err));
			if (!options.quiet) {
				emitRuntimeFeedback(options.onFeedback, {
					type: "refresh_resource_failed",
					level: "warning",
					resource: res.address,
					message: `Failed to refresh ${res.address.type}.${res.address.name} (${res.address.provider}): ${error.message}`,
				});
			}
			errors.push({ resource: res, error });
		}
	}

	if (dirty) {
		await state.save();
	}

	return { removed, errors };
}
