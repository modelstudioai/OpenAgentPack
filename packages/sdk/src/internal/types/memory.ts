export type MemoryMetadata = Record<string, string>;

export interface MemoryStoreInfo {
	id: string;
	type: "memory_store";
	name: string;
	description: string;
	metadata: MemoryMetadata;
	status?: "active" | "archived" | string;
	entry_count?: number;
	total_size?: number;
	session_count?: number;
	created_by?: MemoryActor;
	created_at: string;
	updated_at: string;
	archived_at?: string | null;
}

export interface MemoryInfo {
	id: string;
	type: "memory";
	memory_store_id: string;
	path: string;
	content?: string | null;
	content_size_bytes: number;
	content_sha256: string;
	version?: number;
	memory_version_id?: string;
	metadata: MemoryMetadata;
	created_by?: MemoryActor;
	created_at: string;
	updated_at: string;
}

export interface MemoryPrefixInfo {
	type: "memory_prefix";
	path: string;
}

export type MemoryListItem = MemoryInfo | MemoryPrefixInfo;

export type MemoryVersionOperation = "created" | "updated" | "modified" | "deleted";

export interface MemoryActor {
	type: string;
	api_key_id?: string;
	session_id?: string;
	user_id?: string;
}

export interface MemoryVersionInfo {
	id: string;
	type: "memory_version";
	memory_store_id: string;
	memory_id: string;
	path?: string | null;
	content?: string | null;
	content_size_bytes?: number | null;
	content_sha256?: string | null;
	operation: MemoryVersionOperation;
	version?: number;
	redacted?: boolean;
	redacted_at?: string | null;
	created_by?: MemoryActor;
	created_at: string;
}

export interface MemoryPage<T> {
	data: T[];
	has_more: boolean;
	next_cursor?: string;
}

export interface MemoryProviderCapabilities {
	archive_store: boolean;
	batch_create: boolean;
	versions: boolean;
	optimistic_concurrency: boolean;
	memory_metadata: boolean;
}

export interface MemoryStoreListOptions {
	limit?: number;
	cursor?: string;
	include_archived?: boolean;
}

export interface MemoryListOptions {
	limit?: number;
	cursor?: string;
	prefix?: string;
	depth?: number;
	view?: "basic" | "full";
}

export interface MemoryVersionListOptions {
	limit?: number;
	cursor?: string;
	memory_id?: string;
	view?: "basic" | "full";
}

export interface CreateMemoryStoreInput {
	name: string;
	description?: string;
	metadata?: MemoryMetadata;
}

export interface UpdateMemoryStoreInput {
	name?: string;
	description?: string;
	metadata?: MemoryMetadata;
}

export interface CreateMemoryInput {
	path: string;
	content: string;
	metadata?: MemoryMetadata;
}

export interface BatchCreateMemoryInput {
	items: CreateMemoryInput[];
	on_conflict?: "overwrite" | "fail";
}

export interface BatchCreateMemoryResultItem {
	path: string;
	memory?: MemoryInfo;
	error?: { type: string; message: string };
}

export interface BatchCreateMemoryResult {
	results: BatchCreateMemoryResultItem[];
}

export interface UpdateMemoryInput {
	path?: string;
	content?: string;
	metadata?: MemoryMetadata;
	expected_content_sha256?: string;
}
