import type {
	BatchCreateMemoryInput,
	BatchCreateMemoryResult,
	CreateMemoryInput,
	MemoryInfo,
	MemoryListItem,
	MemoryListOptions,
	MemoryPage,
	MemoryStoreInfo,
	MemoryStoreListOptions,
	MemoryVersionInfo,
	MemoryVersionListOptions,
	UpdateMemoryInput,
	UpdateMemoryStoreInput,
} from "../types/memory.ts";
import type { BaseApiClient } from "./base-client.ts";

export type MemoryPathStyle = "relative" | "absolute";

export interface MemoryApiDialect {
	pathStyle: MemoryPathStyle;
	cursorParam: "after_id" | "page";
	updatePrecondition: "none" | "content_sha256" | "expected_content_sha256" | "precondition";
	prefixParam: "prefix" | "path_prefix";
	versionsSegment?: "memory_versions" | "versions";
	storeMetadataMode?: "replace" | "merge_patch";
	supportsView: boolean;
	supportsMemoryMetadata: boolean;
	supportsPathUpdate?: boolean;
	supportsDeletePrecondition: boolean;
	supportsIncludeArchived: boolean;
}

function query(path: string, values: Record<string, unknown>): string {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(values)) {
		if (value !== undefined && value !== null) params.set(key, String(value));
	}
	const encoded = params.toString();
	return encoded ? `${path}?${encoded}` : path;
}

function canonicalPath(path: string): string {
	return path.replace(/^\/+/, "");
}

function providerPath(path: string, style: MemoryPathStyle): string {
	const relative = canonicalPath(path);
	return style === "absolute" ? `/${relative}` : relative;
}

function page<T>(raw: unknown, map: (item: Record<string, unknown>) => T): MemoryPage<T> {
	const body = raw as Record<string, unknown>;
	const data = (
		(body.data ?? body.items ?? body.memories ?? body.memory_stores ?? body.memory_versions ?? []) as Record<
			string,
			unknown
		>[]
	).map(map);
	const next = (body.next_cursor ?? body.next_page ?? body.last_id) as string | undefined;
	return { data, has_more: Boolean(body.has_more ?? next), ...(next ? { next_cursor: next } : {}) };
}

export function mapMemoryStore(raw: Record<string, unknown>): MemoryStoreInfo {
	return {
		id: String(raw.id),
		type: "memory_store",
		name: String(raw.name ?? ""),
		description: String(raw.description ?? ""),
		metadata: (raw.metadata as Record<string, string> | undefined) ?? {},
		...(raw.status ? { status: String(raw.status) } : {}),
		...(typeof (raw.entry_count ?? raw.memory_count) === "number"
			? { entry_count: Number(raw.entry_count ?? raw.memory_count) }
			: {}),
		...(typeof (raw.total_size ?? raw.storage_bytes) === "number"
			? { total_size: Number(raw.total_size ?? raw.storage_bytes) }
			: {}),
		...(typeof raw.session_count === "number" ? { session_count: raw.session_count } : {}),
		created_by: raw.created_by as MemoryStoreInfo["created_by"],
		created_at: String(raw.created_at ?? ""),
		updated_at: String(raw.updated_at ?? raw.created_at ?? ""),
		archived_at: (raw.archived_at as string | null | undefined) ?? null,
	};
}

export function mapMemory(raw: Record<string, unknown>): MemoryInfo {
	return {
		id: String(raw.id),
		type: "memory",
		memory_store_id: String(raw.memory_store_id ?? raw.store_id ?? ""),
		path: canonicalPath(String(raw.path ?? "")),
		content: raw.content as string | null | undefined,
		content_size_bytes: Number(raw.content_size_bytes ?? raw.size ?? 0),
		content_sha256: String(raw.content_sha256 ?? ""),
		...(typeof raw.version === "number" ? { version: raw.version } : {}),
		...(raw.memory_version_id ? { memory_version_id: String(raw.memory_version_id) } : {}),
		metadata: (raw.metadata as Record<string, string> | undefined) ?? {},
		created_by: raw.created_by as MemoryInfo["created_by"],
		created_at: String(raw.created_at ?? ""),
		updated_at: String(raw.updated_at ?? raw.created_at ?? ""),
	};
}

function mapMemoryListItem(raw: Record<string, unknown>): MemoryListItem {
	if (raw.type === "memory_prefix") return { type: "memory_prefix", path: canonicalPath(String(raw.path ?? "")) };
	return mapMemory(raw);
}

export function mapMemoryVersion(raw: Record<string, unknown>): MemoryVersionInfo {
	const operation = String(raw.operation ?? raw.action ?? "updated");
	return {
		id: String(raw.id),
		type: "memory_version",
		memory_store_id: String(raw.memory_store_id ?? raw.store_id ?? ""),
		memory_id: String(raw.memory_id ?? raw.entry_id ?? ""),
		path:
			(raw.path ?? raw.entry_path) == null
				? ((raw.path ?? raw.entry_path) as null | undefined)
				: canonicalPath(String(raw.path ?? raw.entry_path)),
		content: raw.content as string | null | undefined,
		content_size_bytes: (raw.content_size_bytes ?? raw.size) as number | null | undefined,
		content_sha256: raw.content_sha256 as string | null | undefined,
		operation: (operation === "modified" ? "updated" : operation) as MemoryVersionInfo["operation"],
		...(typeof raw.version === "number" ? { version: raw.version } : {}),
		...(typeof raw.redacted === "boolean" ? { redacted: raw.redacted } : {}),
		redacted_at: raw.redacted_at as string | null | undefined,
		created_by: raw.created_by as MemoryVersionInfo["created_by"],
		created_at: String(raw.created_at ?? ""),
	};
}

export class ProviderMemoryApi {
	constructor(
		private readonly client: BaseApiClient,
		private readonly dialect: MemoryApiDialect,
	) {}

	async listStores(options: MemoryStoreListOptions = {}): Promise<MemoryPage<MemoryStoreInfo>> {
		const raw = await this.client.get(
			query("/memory_stores", {
				limit: options.limit,
				[this.dialect.cursorParam]: options.cursor,
				include_archived: this.dialect.supportsIncludeArchived ? options.include_archived : undefined,
			}),
		);
		return page(raw, mapMemoryStore);
	}

	async getStore(id: string): Promise<MemoryStoreInfo> {
		return mapMemoryStore((await this.client.get(`/memory_stores/${id}`)) as Record<string, unknown>);
	}

	async updateStore(id: string, input: UpdateMemoryStoreInput): Promise<MemoryStoreInfo> {
		let body: Record<string, unknown> = { ...input };
		if (this.dialect.storeMetadataMode === "merge_patch" && input.metadata !== undefined) {
			const current = await this.getStore(id);
			body = {
				...input,
				metadata: {
					...Object.fromEntries(Object.keys(current.metadata).map((key) => [key, null])),
					...input.metadata,
				},
			};
		}
		return mapMemoryStore((await this.client.post(`/memory_stores/${id}`, body)) as Record<string, unknown>);
	}

	async archiveStore(id: string): Promise<MemoryStoreInfo> {
		return mapMemoryStore((await this.client.post(`/memory_stores/${id}/archive`, {})) as Record<string, unknown>);
	}

	async createMemory(storeId: string, input: CreateMemoryInput): Promise<MemoryInfo> {
		const body = {
			path: providerPath(input.path, this.dialect.pathStyle),
			content: input.content,
			...(this.dialect.supportsMemoryMetadata && input.metadata ? { metadata: input.metadata } : {}),
		};
		return mapMemory((await this.client.post(`/memory_stores/${storeId}/memories`, body)) as Record<string, unknown>);
	}

	async listMemories(storeId: string, options: MemoryListOptions = {}): Promise<MemoryPage<MemoryListItem>> {
		const raw = await this.client.get(
			query(`/memory_stores/${storeId}/memories`, {
				limit: options.limit,
				[this.dialect.cursorParam]: options.cursor,
				[this.dialect.prefixParam]: options.prefix ? providerPath(options.prefix, this.dialect.pathStyle) : undefined,
				depth: options.depth,
				view: this.dialect.supportsView ? options.view : undefined,
			}),
		);
		return page(raw, mapMemoryListItem);
	}

	async getMemory(storeId: string, memoryId: string): Promise<MemoryInfo> {
		const path = `/memory_stores/${storeId}/memories/${memoryId}${this.dialect.supportsView ? "?view=full" : ""}`;
		return mapMemory((await this.client.get(path)) as Record<string, unknown>);
	}

	async updateMemory(storeId: string, memoryId: string, input: UpdateMemoryInput): Promise<MemoryInfo> {
		const { expected_content_sha256, ...values } = input;
		const body: Record<string, unknown> = {
			...(values.content !== undefined ? { content: values.content } : {}),
			...(this.dialect.supportsMemoryMetadata && values.metadata ? { metadata: values.metadata } : {}),
			...(this.dialect.supportsPathUpdate !== false && values.path
				? { path: providerPath(values.path, this.dialect.pathStyle) }
				: {}),
		};
		if (expected_content_sha256 && this.dialect.updatePrecondition !== "none") {
			if (this.dialect.updatePrecondition === "precondition") {
				body.precondition = { type: "content_sha256", content_sha256: expected_content_sha256 };
			} else {
				body[this.dialect.updatePrecondition] = expected_content_sha256;
			}
		}
		const path = `/memory_stores/${storeId}/memories/${memoryId}${this.dialect.supportsView ? "?view=full" : ""}`;
		const raw = await this.client.post(path, body);
		return mapMemory(raw as Record<string, unknown>);
	}

	async deleteMemory(storeId: string, memoryId: string, expected?: string): Promise<void> {
		await this.client.delete(
			query(`/memory_stores/${storeId}/memories/${memoryId}`, {
				expected_content_sha256: this.dialect.supportsDeletePrecondition ? expected : undefined,
			}),
		);
	}

	async listVersions(storeId: string, options: MemoryVersionListOptions = {}): Promise<MemoryPage<MemoryVersionInfo>> {
		const segment = this.dialect.versionsSegment ?? "memory_versions";
		const raw = await this.client.get(
			query(`/memory_stores/${storeId}/${segment}`, {
				limit: options.limit,
				[this.dialect.cursorParam]: options.cursor,
				memory_id: options.memory_id,
				view: this.dialect.supportsView ? options.view : undefined,
			}),
		);
		return page(raw, mapMemoryVersion);
	}

	async getVersion(storeId: string, versionId: string): Promise<MemoryVersionInfo> {
		const segment = this.dialect.versionsSegment ?? "memory_versions";
		return mapMemoryVersion(
			(await this.client.get(
				`/memory_stores/${storeId}/${segment}/${versionId}${this.dialect.supportsView ? "?view=full" : ""}`,
			)) as Record<string, unknown>,
		);
	}

	async redactVersion(storeId: string, versionId: string): Promise<MemoryVersionInfo> {
		const segment = this.dialect.versionsSegment ?? "memory_versions";
		return mapMemoryVersion(
			(await this.client.post(`/memory_stores/${storeId}/${segment}/${versionId}/redact`, {})) as Record<
				string,
				unknown
			>,
		);
	}

	async batchCreateMemories(storeId: string, input: BatchCreateMemoryInput): Promise<BatchCreateMemoryResult> {
		const body = {
			items: input.items.map((item) => ({
				path: providerPath(item.path, this.dialect.pathStyle),
				content: item.content,
			})),
			on_conflict: input.on_conflict,
		};
		const raw = (await this.client.post(`/memory_stores/${storeId}/memories/batch_create`, body)) as {
			results?: Array<{ path: string; memory?: Record<string, unknown>; error?: { type: string; message: string } }>;
		};
		return {
			results: (raw.results ?? []).map((item) => ({
				path: canonicalPath(item.path),
				...(item.memory ? { memory: mapMemory(item.memory) } : {}),
				...(item.error ? { error: item.error } : {}),
			})),
		};
	}
}
