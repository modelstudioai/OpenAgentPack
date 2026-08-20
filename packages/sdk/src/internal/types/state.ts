import type { ResourceAddress } from "./dto.ts";

export type { ResourceAddress, ResourceType } from "./dto.ts";

export interface ResourceState {
	address: ResourceAddress;
	remote_id: string | null;
	/**
	 * This resource is owned by the provider or another system and is only
	 * referenced by this project. It must never be deleted remotely.
	 */
	externally_managed?: boolean;
	version?: number;
	/**
	 * Backward-compatible alias for desired_hash. Kept while older state files
	 * and callers still read/write content_hash directly.
	 */
	content_hash: string;
	desired_hash?: string;
	desired_comparable_hash?: string;
	desired_readiness_baseline?: ResourceReadinessBaseline;
	remote_hash?: string;
	remote_snapshot?: unknown;
	/** Non-reversible declaration fingerprint used to infer safe logical renames. */
	replacement_fingerprint?: string;
	drift_paths?: string[];
	drift_status?: "in_sync" | "drifted" | "missing" | "unchecked";
}

export interface ResourceReadinessBaseline {
	operational_hash: string;
	description_hash: string;
	metadata_hash: string;
}

export interface StateFile {
	resources: ResourceState[];
	pending_default_memory_store_cleanups?: PendingDefaultMemoryStoreCleanup[];
}

export interface PendingDefaultMemoryStoreCleanup {
	agent_name: string;
	provider: string;
	remote_id: string;
	identity_id?: string;
	template_id?: string;
	last_error?: string;
}

export function addressKey(addr: ResourceAddress): string {
	return `${addr.provider}.${addr.type}.${addr.name}`;
}
