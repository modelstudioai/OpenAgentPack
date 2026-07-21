import { UserError } from "../errors.ts";
import type { ProviderAdapter } from "../providers/interface.ts";
import type {
	BatchCreateMemoryInput,
	CreateMemoryInput,
	CreateMemoryStoreInput,
	MemoryListOptions,
	MemoryStoreListOptions,
	MemoryVersionListOptions,
	UpdateMemoryInput,
	UpdateMemoryStoreInput,
} from "../types/memory.ts";

function adapter(providers: ReadonlyMap<string, ProviderAdapter>, provider: string): ProviderAdapter {
	const value = providers.get(provider);
	if (!value) throw new UserError(`Provider '${provider}' is not configured.`);
	return value;
}

function method<T extends keyof ProviderAdapter>(value: ProviderAdapter, name: T): NonNullable<ProviderAdapter[T]> {
	const fn = value[name];
	if (typeof fn !== "function")
		throw new UserError(`Provider '${value.name}' does not support memory operation '${String(name)}'.`);
	return fn.bind(value) as NonNullable<ProviderAdapter[T]>;
}

export function listMemoryStores(
	providers: ReadonlyMap<string, ProviderAdapter>,
	provider: string,
	options?: MemoryStoreListOptions,
) {
	const value = adapter(providers, provider);
	return method(value, "listMemoryStores")(options);
}
export function getMemoryProviderCapabilities(providers: ReadonlyMap<string, ProviderAdapter>, provider: string) {
	const value = adapter(providers, provider);
	if (!value.memoryCapabilities) throw new UserError(`Provider '${provider}' does not support memory stores.`);
	return value.memoryCapabilities;
}
export async function createMemoryStore(
	providers: ReadonlyMap<string, ProviderAdapter>,
	provider: string,
	input: CreateMemoryStoreInput,
) {
	const value = adapter(providers, provider);
	const created = await method(value, "createMemoryStore")(input.name, {
		description: input.description ?? "",
		metadata: input.metadata,
	});
	if (!created.id) throw new UserError(`Provider '${provider}' returned no memory store id.`);
	return method(value, "getMemoryStore")(created.id);
}
export function deleteMemoryStore(providers: ReadonlyMap<string, ProviderAdapter>, provider: string, id: string) {
	const value = adapter(providers, provider);
	return method(value, "deleteMemoryStore")(id);
}
export function getMemoryStore(providers: ReadonlyMap<string, ProviderAdapter>, provider: string, id: string) {
	const value = adapter(providers, provider);
	return method(value, "getMemoryStore")(id);
}
export function updateMemoryStore(
	providers: ReadonlyMap<string, ProviderAdapter>,
	provider: string,
	id: string,
	input: UpdateMemoryStoreInput,
) {
	const value = adapter(providers, provider);
	return method(value, "updateMemoryStore")(id, input);
}
export function archiveMemoryStore(providers: ReadonlyMap<string, ProviderAdapter>, provider: string, id: string) {
	const value = adapter(providers, provider);
	return method(value, "archiveMemoryStore")(id);
}
export function createMemory(
	providers: ReadonlyMap<string, ProviderAdapter>,
	provider: string,
	storeId: string,
	input: CreateMemoryInput,
) {
	const value = adapter(providers, provider);
	return method(value, "createMemory")(storeId, input);
}
export function batchCreateMemories(
	providers: ReadonlyMap<string, ProviderAdapter>,
	provider: string,
	storeId: string,
	input: BatchCreateMemoryInput,
) {
	const value = adapter(providers, provider);
	return method(value, "batchCreateMemories")(storeId, input);
}
export function listMemories(
	providers: ReadonlyMap<string, ProviderAdapter>,
	provider: string,
	storeId: string,
	options?: MemoryListOptions,
) {
	const value = adapter(providers, provider);
	return method(value, "listMemories")(storeId, options);
}
export function getMemory(
	providers: ReadonlyMap<string, ProviderAdapter>,
	provider: string,
	storeId: string,
	memoryId: string,
) {
	const value = adapter(providers, provider);
	return method(value, "getMemory")(storeId, memoryId);
}
export function updateMemory(
	providers: ReadonlyMap<string, ProviderAdapter>,
	provider: string,
	storeId: string,
	memoryId: string,
	input: UpdateMemoryInput,
) {
	const value = adapter(providers, provider);
	return method(value, "updateMemory")(storeId, memoryId, input);
}
export function deleteMemory(
	providers: ReadonlyMap<string, ProviderAdapter>,
	provider: string,
	storeId: string,
	memoryId: string,
	expected?: string,
) {
	const value = adapter(providers, provider);
	return method(value, "deleteMemory")(storeId, memoryId, expected);
}
export function listMemoryVersions(
	providers: ReadonlyMap<string, ProviderAdapter>,
	provider: string,
	storeId: string,
	options?: MemoryVersionListOptions,
) {
	const value = adapter(providers, provider);
	return method(value, "listMemoryVersions")(storeId, options);
}
export function getMemoryVersion(
	providers: ReadonlyMap<string, ProviderAdapter>,
	provider: string,
	storeId: string,
	versionId: string,
) {
	const value = adapter(providers, provider);
	return method(value, "getMemoryVersion")(storeId, versionId);
}
export function redactMemoryVersion(
	providers: ReadonlyMap<string, ProviderAdapter>,
	provider: string,
	storeId: string,
	versionId: string,
) {
	const value = adapter(providers, provider);
	return method(value, "redactMemoryVersion")(storeId, versionId);
}
