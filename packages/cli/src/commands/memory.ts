import { readFile } from "node:fs/promises";
import {
	archiveMemoryStore,
	batchCreateMemories,
	createMemory,
	createMemoryStore,
	deleteMemory,
	deleteMemoryStore,
	getMemory,
	getMemoryStore,
	getMemoryVersion,
	listMemories,
	listMemoryStores,
	listMemoryVersions,
	redactMemoryVersion,
	UserError,
	updateMemory,
	updateMemoryStore,
} from "@openagentpack/sdk";
import { buildCliRuntime } from "../config-loader.ts";
import { writeJson } from "../runtime.ts";

interface CommonOptions {
	file: string;
	provider?: string;
}

async function runtime(options: CommonOptions) {
	const ctx = await buildCliRuntime(options.file);
	const provider = options.provider ?? (ctx.providers.size === 1 ? ctx.providers.keys().next().value : undefined);
	if (!provider) throw new UserError("Select a provider with --provider when multiple providers are configured.");
	return { ctx, provider } as const;
}

async function content(options: { content?: string; contentFile?: string }): Promise<string> {
	if (options.content !== undefined && options.contentFile)
		throw new UserError("Use either --content or --content-file, not both.");
	if (options.contentFile) return readFile(options.contentFile, "utf8");
	if (options.content !== undefined) return options.content;
	throw new UserError("Memory content is required; use --content or --content-file.");
}

export async function memoryStoreListCommand(
	options: CommonOptions & { limit?: number; cursor?: string; includeArchived?: boolean },
) {
	const { ctx, provider } = await runtime(options);
	writeJson(await listMemoryStores(ctx.providers, provider, options));
}
export async function memoryStoreCreateCommand(name: string, options: CommonOptions & { description?: string }) {
	const { ctx, provider } = await runtime(options);
	writeJson(await createMemoryStore(ctx.providers, provider, { name, description: options.description }));
}
export async function memoryStoreDeleteCommand(id: string, options: CommonOptions) {
	const { ctx, provider } = await runtime(options);
	await deleteMemoryStore(ctx.providers, provider, id);
	writeJson({ id, type: "memory_store_deleted" });
}
export async function memoryStoreGetCommand(id: string, options: CommonOptions) {
	const { ctx, provider } = await runtime(options);
	writeJson(await getMemoryStore(ctx.providers, provider, id));
}
export async function memoryStoreUpdateCommand(
	id: string,
	options: CommonOptions & { name?: string; description?: string },
) {
	const { ctx, provider } = await runtime(options);
	writeJson(
		await updateMemoryStore(ctx.providers, provider, id, { name: options.name, description: options.description }),
	);
}
export async function memoryStoreArchiveCommand(id: string, options: CommonOptions) {
	const { ctx, provider } = await runtime(options);
	writeJson(await archiveMemoryStore(ctx.providers, provider, id));
}
export async function memoryCreateCommand(
	storeId: string,
	path: string,
	options: CommonOptions & { content?: string; contentFile?: string },
) {
	const { ctx, provider } = await runtime(options);
	writeJson(await createMemory(ctx.providers, provider, storeId, { path, content: await content(options) }));
}
export async function memoryBatchCreateCommand(
	storeId: string,
	inputFile: string,
	options: CommonOptions & { onConflict?: "overwrite" | "fail" },
) {
	const { ctx, provider } = await runtime(options);
	const parsed = JSON.parse(await readFile(inputFile, "utf8")) as unknown;
	if (!Array.isArray(parsed)) throw new UserError("Batch input must be a JSON array of {path, content} objects.");
	const items = parsed.map((item) => {
		if (
			!item ||
			typeof item !== "object" ||
			typeof (item as { path?: unknown }).path !== "string" ||
			typeof (item as { content?: unknown }).content !== "string"
		) {
			throw new UserError("Every batch item must contain string path and content fields.");
		}
		return item as { path: string; content: string };
	});
	writeJson(await batchCreateMemories(ctx.providers, provider, storeId, { items, on_conflict: options.onConflict }));
}
export async function memoryListCommand(
	storeId: string,
	options: CommonOptions & { limit?: number; cursor?: string; prefix?: string; depth?: number; full?: boolean },
) {
	const { ctx, provider } = await runtime(options);
	writeJson(
		await listMemories(ctx.providers, provider, storeId, { ...options, view: options.full ? "full" : "basic" }),
	);
}
export async function memoryGetCommand(storeId: string, memoryId: string, options: CommonOptions) {
	const { ctx, provider } = await runtime(options);
	writeJson(await getMemory(ctx.providers, provider, storeId, memoryId));
}
export async function memoryUpdateCommand(
	storeId: string,
	memoryId: string,
	options: CommonOptions & { path?: string; content?: string; contentFile?: string; expectedSha256?: string },
) {
	const { ctx, provider } = await runtime(options);
	const nextContent = options.content !== undefined || options.contentFile ? await content(options) : undefined;
	writeJson(
		await updateMemory(ctx.providers, provider, storeId, memoryId, {
			path: options.path,
			content: nextContent,
			expected_content_sha256: options.expectedSha256,
		}),
	);
}
export async function memoryDeleteCommand(
	storeId: string,
	memoryId: string,
	options: CommonOptions & { expectedSha256?: string },
) {
	const { ctx, provider } = await runtime(options);
	await deleteMemory(ctx.providers, provider, storeId, memoryId, options.expectedSha256);
	writeJson({ id: memoryId, type: "memory_deleted" });
}
export async function memoryVersionListCommand(
	storeId: string,
	options: CommonOptions & { limit?: number; cursor?: string; memoryId?: string; full?: boolean },
) {
	const { ctx, provider } = await runtime(options);
	writeJson(
		await listMemoryVersions(ctx.providers, provider, storeId, {
			...options,
			memory_id: options.memoryId,
			view: options.full ? "full" : "basic",
		}),
	);
}
export async function memoryVersionGetCommand(storeId: string, versionId: string, options: CommonOptions) {
	const { ctx, provider } = await runtime(options);
	writeJson(await getMemoryVersion(ctx.providers, provider, storeId, versionId));
}
export async function memoryVersionRedactCommand(storeId: string, versionId: string, options: CommonOptions) {
	const { ctx, provider } = await runtime(options);
	writeJson(await redactMemoryVersion(ctx.providers, provider, storeId, versionId));
}
