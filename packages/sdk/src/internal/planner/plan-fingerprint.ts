import type { IStateManager } from "../state/state-manager.ts";
import type { ExecutionPlan } from "../types/plan.ts";
import { addressKey, type ResourceAddress } from "../types/state.ts";
import { contentHash } from "../utils/hash.ts";

interface FingerprintInput {
	plan: ExecutionPlan;
	executionContext: { state: IStateManager };
	mode?: string;
	targetProviders?: string[];
	selectedAddresses?: ResourceAddress[];
}

/** Versioned execution semantics only: no credentials, response snapshots, timestamps or display messages. */
export function resourcePlanFingerprint(input: FingerprintInput): string {
	const keys = new Set(
		input.plan.actions
			.flatMap((action) => [
				action.address,
				...(action.previousAddress ? [action.previousAddress] : []),
				...action.dependencies,
			])
			.map(addressKey),
	);
	const state = input.executionContext.state.getStateFile();
	const resources = state.resources
		.filter((resource) => keys.has(addressKey(resource.address)))
		.map((resource) => ({
			address: resource.address,
			remote_id: resource.remote_id,
			version: resource.version,
			content_hash: resource.content_hash,
			desired_hash: resource.desired_hash,
			remote_hash: resource.remote_hash,
			desired_comparable_hash: resource.desired_comparable_hash,
			desired_readiness_baseline: resource.desired_readiness_baseline,
			externally_managed: resource.externally_managed,
			api_mode: resource.api_mode,
			memory_initialization: resource.memory_initialization,
			replacement_fingerprint: resource.replacement_fingerprint,
			drift_status: resource.drift_status,
			drift_paths: resource.drift_paths?.slice().sort(),
		}))
		.sort((left, right) => addressKey(left.address).localeCompare(addressKey(right.address)));
	const actions = input.plan.actions
		.map((action) => ({
			action: action.action,
			address: action.address,
			previousAddress: action.previousAddress,
			dependencies: action.dependencies.map(addressKey).sort(),
			before: action.before
				? {
						content_hash: action.before.content_hash,
						remote_hash: action.before.remote_hash,
						drift_paths: action.before.drift_paths,
					}
				: undefined,
			after: action.after ? { content_hash: action.after.content_hash } : undefined,
			driftKind: action.driftKind,
			readinessImpact: action.readinessImpact,
			changedPaths: action.changedPaths?.slice().sort(),
		}))
		.sort((left, right) => addressKey(left.address).localeCompare(addressKey(right.address)));
	return `resource-plan-v1:${contentHash({
		mode: input.mode ?? "reconcile",
		providers: input.targetProviders?.slice().sort(),
		scope: input.selectedAddresses?.map(addressKey).sort(),
		actions,
		resources,
		diagnostics: input.plan.diagnostics
			.map(({ code, severity, resource }) => ({ code, severity, resource }))
			.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
		pendingDefaultMemoryStores:
			input.mode === "create-only"
				? undefined
				: state.pending_default_memory_store_cleanups
						?.map(({ last_error: _error, ...cleanup }) => cleanup)
						.sort((left, right) => left.remote_id.localeCompare(right.remote_id)),
	})}`;
}
