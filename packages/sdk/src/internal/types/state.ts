import type { ResourceAddress } from "./dto.ts";

export type { ResourceAddress, ResourceType } from "./dto.ts";

export interface ResourceState {
	address: ResourceAddress;
	remote_id: string | null;
	version?: number;
	/**
	 * Backward-compatible alias for desired_hash. Kept while older state files
	 * and callers still read/write content_hash directly.
	 */
	content_hash: string;
	desired_hash?: string;
	desired_comparable_hash?: string;
	remote_hash?: string;
	remote_snapshot?: unknown;
	drift_status?: "in_sync" | "drifted" | "missing" | "unchecked";
}

export interface StateFile {
	resources: ResourceState[];
}

export function addressKey(addr: ResourceAddress): string {
	return `${addr.provider}.${addr.type}.${addr.name}`;
}
