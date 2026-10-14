import { UserError } from "../errors.ts";
import type { ProviderResourceMode } from "../providers/interface.ts";
import type { ResourceCrudAdapter } from "../providers/resource-workflow.ts";
import type { MemoryStoreDecl } from "../types/config.ts";
import type { ResourceAddress } from "../types/state.ts";
import { sha256 } from "../utils/hash.ts";
import type { ExecContext } from "./context.ts";

export function memoryInitializationEntries(declaration: MemoryStoreDecl) {
	const entries = (declaration.entries ?? []).map((entry) => ({
		path: `/${entry.key.replace(/^\/+/, "")}`,
		content: entry.content,
	}));
	const paths = new Set<string>();
	for (const entry of entries) {
		if (paths.has(entry.path)) {
			throw new UserError(`Duplicate memory initialization path '${entry.path}'. / 重复的记忆初始化路径。`);
		}
		if (Buffer.byteLength(entry.content, "utf8") > 102400) {
			throw new UserError(`Memory '${entry.path}' exceeds 102400 UTF-8 bytes. / 记忆正文超过 102400 UTF-8 字节。`);
		}
		paths.add(entry.path);
	}
	return entries;
}

type MemoryInitializerAdapter = Pick<ResourceCrudAdapter, "listMemories" | "createMemory">;

async function existingMemoryPaths(provider: MemoryInitializerAdapter, storeId: string, mode?: ProviderResourceMode) {
	if (!provider.listMemories) throw new UserError("Provider does not support Memory initialization.");
	const paths = new Set<string>();
	const seenCursors = new Set<string>();
	let cursor: string | undefined;
	do {
		const page = await provider.listMemories(storeId, { limit: 100, cursor, view: "basic" }, mode);
		for (const memory of page.data) {
			if (memory.type === "memory") paths.add(memory.path);
		}
		cursor = page.next_page ?? (page.has_more ? page.next_cursor : undefined);
		if (cursor && seenCursors.has(cursor)) {
			throw new UserError("Memory pagination returned a repeated cursor. / 记忆分页返回了重复游标。");
		}
		if (cursor) seenCursors.add(cursor);
	} while (cursor);
	return paths;
}

/** Resume only the frozen initializer of this newly-created store; never update existing files. */
export async function initializeBailianMemories(
	ctx: ExecContext,
	address: ResourceAddress,
	provider: MemoryInitializerAdapter,
	declaration: MemoryStoreDecl,
	mode?: ProviderResourceMode,
): Promise<void> {
	const resource = ctx.state.getResource(address);
	const initialization = resource?.memory_initialization;
	if (!resource?.remote_id || !initialization) return;
	if (!provider.createMemory || !provider.listMemories) {
		throw new UserError("Provider does not support Memory initialization.");
	}
	const entries = new Map(memoryInitializationEntries(declaration).map((entry) => [entry.path, entry]));
	for (const pending of initialization.pending_entries) {
		const entry = entries.get(pending.path);
		if (!entry || sha256(entry.content) !== pending.content_sha256) {
			throw new UserError(
				`Memory initializer '${pending.path}' changed after the store was created. Restore its original content to resume. / 记忆库创建后初始化源发生变更，请恢复原始正文后重试。`,
			);
		}
	}
	let existingPaths = initialization.pending_entries.length
		? await existingMemoryPaths(provider, resource.remote_id, mode)
		: new Set<string>();
	for (const pending of [...initialization.pending_entries]) {
		const entry = entries.get(pending.path)!;
		if (!existingPaths.has(pending.path)) {
			try {
				await provider.createMemory(resource.remote_id, entry, mode);
			} catch (error) {
				// A lost response may follow a successful create. Preserve the original
				// service error unless a read confirms that the path now exists.
				try {
					existingPaths = await existingMemoryPaths(provider, resource.remote_id, mode);
				} catch {
					throw error;
				}
				if (!existingPaths.has(pending.path)) throw error;
			}
			existingPaths.add(pending.path);
		}
		initialization.pending_entries = initialization.pending_entries.filter((entry) => entry.path !== pending.path);
		ctx.state.setResource({ ...resource, memory_initialization: initialization });
		await ctx.state.save();
	}
	const completed = { ...resource };
	delete completed.memory_initialization;
	ctx.state.setResource(completed);
	await ctx.state.save();
}
