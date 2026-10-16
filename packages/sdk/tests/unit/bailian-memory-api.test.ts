import { afterEach, describe, expect, test } from "bun:test";
import {
	ApiError,
	archiveMemoryStore,
	createMemory,
	createMemoryStore,
	deleteMemory,
	getMemory,
	getMemoryStore,
	getMemoryVersion,
	listMemories,
	listMemoryStores,
	listMemoryVersions,
	redactMemoryVersion,
	setDefaultFetch,
	updateMemory,
	updateMemoryStore,
} from "../../src/index.ts";
import { BailianAdapter } from "../../src/internal/providers/bailian/adapter.ts";
import { BAILIAN_CAPABILITIES } from "../../src/internal/providers/bailian/capabilities.ts";
import type { ProviderAdapter } from "../../src/internal/providers/interface.ts";

const BASE_URL = "https://workspace.example/api/v1/agentstudio";
const store = {
	id: "memstore_notes",
	type: "memory_store",
	name: "Project notes",
	description: "Shared project memory",
	metadata: { team: "data", nested: { enabled: true }, revision: 2 },
	created_at: "2026-10-13T00:00:00Z",
	updated_at: "2026-10-13T00:00:00Z",
	service_extension: { enabled: true },
};
const memory = {
	id: "mem_notes",
	type: "memory",
	memory_store_id: store.id,
	path: "/notes/project.md",
	content: "",
	content_sha256: "old-sha",
	content_size_bytes: 0,
	memory_version_id: "memver_created",
	created_at: "2026-10-13T00:00:00Z",
	updated_at: "2026-10-13T00:00:00Z",
	service_extension: "preserved",
};
const version = {
	id: "memver_modified",
	type: "memory_version",
	memory_store_id: store.id,
	memory_id: memory.id,
	operation: "modified",
	path: memory.path,
	content: "updated",
	content_sha256: "new-sha",
	content_size_bytes: 7,
	created_at: "2026-10-13T00:30:00Z",
};

function adapter() {
	return new BailianAdapter("sk-test", "workspace", BASE_URL, "project");
}

function providers(value: BailianAdapter): ReadonlyMap<string, ProviderAdapter> {
	return new Map([["bailian", value]]);
}

function responses(values: unknown[]) {
	const calls: Request[] = [];
	let responseIndex = 0;
	setDefaultFetch(async (input, init) => {
		calls.push(new Request(input, init));
		return Response.json(values[responseIndex++]);
	});
	return calls;
}

afterEach(() => setDefaultFetch(undefined));

describe("Bailian Memory Store official API", () => {
	test("creates only the container and preserves metadata objects through the public API", async () => {
		const calls = responses([store, store]);
		const provider = adapter();
		const created = await createMemoryStore(providers(provider), "bailian", {
			name: store.name,
			description: store.description,
			metadata: store.metadata,
		});
		expect(created).toEqual(store);
		expect(calls.map((call) => [call.method, new URL(call.url).pathname])).toEqual([
			["POST", "/api/v1/agentstudio/memory_stores"],
			["GET", `/api/v1/agentstudio/memory_stores/${store.id}`],
		]);
		expect(await calls[0]?.json()).toEqual({
			name: store.name,
			description: store.description,
			metadata: store.metadata,
		});
		const seedCalls = responses([store]);
		await provider.createMemoryStore(store.name, {
			description: store.description,
			entries: [{ key: "notes/project.md", content: "seed" }],
		});
		expect(seedCalls).toHaveLength(1);
		expect(await seedCalls[0]?.json()).not.toHaveProperty("entries");
	});

	test("keeps native list envelopes, null cursors and unknown Store fields", async () => {
		const rawPage = { data: [store], next_page: "opaque/+page", service_extension: { count: 1 } };
		const calls = responses([rawPage, store, { data: [], next_page: null }]);
		const registry = providers(adapter());
		expect(
			await listMemoryStores(registry, "bailian", { limit: 5, page: "first/+page", include_archived: true }),
		).toEqual(rawPage);
		expect(await getMemoryStore(registry, "bailian", store.id)).toEqual(store);
		expect(await listMemoryStores(registry, "bailian")).toEqual({ data: [], next_page: null });
		const query = new URL(calls[0]!.url).searchParams;
		expect(query.get("page")).toBe("first/+page");
		expect(query.get("include_archived")).toBe("true");
		expect(query.get("limit")).toBe("5");
	});

	test("sends Store metadata as supplied and archives for IaC destroy without a delete route", async () => {
		const archived = { ...store, archived_at: "2026-10-13T01:00:00Z" };
		const calls = responses([store, archived, archived]);
		const provider = adapter();
		expect(
			await updateMemoryStore(providers(provider), "bailian", store.id, { description: "", metadata: {} }),
		).toEqual(store);
		expect(await calls[0]?.json()).toEqual({ description: "", metadata: {} });
		expect(await archiveMemoryStore(providers(provider), "bailian", store.id)).toEqual(archived);
		await provider.deleteMemoryStore(store.id);
		expect(calls.slice(1).map((call) => [call.method, call.url])).toEqual([
			["POST", `${BASE_URL}/memory_stores/${store.id}/archive`],
			["POST", `${BASE_URL}/memory_stores/${store.id}/archive`],
		]);
		expect(await calls[1]?.text()).toBe("");
		expect(await calls[2]?.text()).toBe("");
	});
});

describe("Bailian Memory file and version contracts", () => {
	test("preserves absolute paths, empty bodies and separate directory prefixes", async () => {
		const page = { data: [memory], prefixes: ["/notes/archive/"], next_page: "next", service_extension: 1 };
		const calls = responses([memory, page, memory]);
		const registry = providers(adapter());
		expect(await createMemory(registry, "bailian", store.id, { path: memory.path, content: "" })).toEqual(memory);
		expect(await calls[0]?.json()).toEqual({ path: memory.path, content: "" });
		expect(
			await listMemories(registry, "bailian", store.id, {
				path_prefix: "/notes/",
				depth: 1,
				view: "full",
				limit: 20,
				page: "current",
			}),
		).toEqual(page);
		const query = new URL(calls[1]!.url).searchParams;
		expect(Object.fromEntries(query)).toEqual({
			limit: "20",
			page: "current",
			path_prefix: "/notes/",
			depth: "1",
			view: "full",
		});
		expect(await getMemory(registry, "bailian", store.id, memory.id)).toEqual(memory);
		expect(calls[2]?.url).toBe(`${BASE_URL}/memory_stores/${store.id}/memories/${memory.id}`);
	});

	test("maps SHA conditions and atomic renames without inventing update response content", async () => {
		const { content: _content, ...updated } = { ...memory, path: "/notes/renamed.md", memory_version_id: version.id };
		const calls = responses([updated, updated]);
		const registry = providers(adapter());
		const result = await updateMemory(registry, "bailian", store.id, memory.id, {
			path: "/notes/renamed.md",
			content: "",
			expected_content_sha256: "old-sha",
		});
		expect(result).toEqual(updated);
		expect(result).not.toHaveProperty("content");
		expect(await calls[0]?.json()).toEqual({
			path: "/notes/renamed.md",
			content: "",
			precondition: { type: "content_sha256", content_sha256: "old-sha" },
		});
		expect(new URL(calls[0]!.url).search).toBe("");
		await updateMemory(registry, "bailian", store.id, memory.id, {
			content: "next",
			precondition: { type: "content_sha256", content_sha256: "native-sha" },
		});
		expect(await calls[1]?.json()).toEqual({
			content: "next",
			precondition: { type: "content_sha256", content_sha256: "native-sha" },
		});
	});

	test("returns the delete receipt without sending an unsupported delete precondition", async () => {
		const deleted = { id: memory.id, type: "memory_deleted", service_extension: "kept" };
		const calls = responses([deleted]);
		expect(
			await deleteMemory(providers(adapter()), "bailian", store.id, memory.id, "ignored-native-delete-sha"),
		).toEqual(deleted);
		expect(calls[0]?.method).toBe("DELETE");
		expect(calls[0]?.url).toBe(`${BASE_URL}/memory_stores/${store.id}/memories/${memory.id}`);
		expect(await calls[0]?.text()).toBe("");
	});

	test("uses native version filters and preserves modified and redacted field absence", async () => {
		const page = { data: [version], next_page: "versions-next" };
		const redacted = {
			id: version.id,
			type: "memory_version",
			memory_store_id: store.id,
			memory_id: memory.id,
			operation: "modified",
			path: memory.path,
			created_at: version.created_at,
			redacted_at: "2026-10-13T01:00:00Z",
		};
		const calls = responses([page, version, redacted]);
		const registry = providers(adapter());
		expect(
			await listMemoryVersions(registry, "bailian", store.id, {
				memory_id: memory.id,
				operation: "modified",
				"created_at.gte": "2026-10-13T00:00:00Z",
				"created_at.lte": "2026-10-13T01:00:00Z",
				view: "full",
				limit: 20,
				page: "versions-current",
			}),
		).toEqual(page);
		expect(Object.fromEntries(new URL(calls[0]!.url).searchParams)).toEqual({
			limit: "20",
			page: "versions-current",
			memory_id: memory.id,
			operation: "modified",
			"created_at.gte": "2026-10-13T00:00:00Z",
			"created_at.lte": "2026-10-13T01:00:00Z",
			view: "full",
		});
		expect(await getMemoryVersion(registry, "bailian", store.id, version.id)).toEqual(version);
		expect(new URL(calls[1]!.url).search).toBe("");
		expect(await redactMemoryVersion(registry, "bailian", store.id, version.id)).toEqual(redacted);
		expect(calls[2]?.url).toBe(`${BASE_URL}/memory_stores/${store.id}/memory_versions/${version.id}/redact`);
		expect(await calls[2]?.text()).toBe("");
	});

	test("retains the exact service error body and does not retry conflicting updates", async () => {
		const body = JSON.stringify({
			type: "error",
			error: {
				code: "memory_precondition_failed_error",
				message: "Content was changed by another session.",
			},
			request_id: "req-conflict",
		});
		const calls: Request[] = [];
		setDefaultFetch(async (input, init) => {
			calls.push(new Request(input, init));
			return new Response(body, { status: 409 });
		});
		let failure: unknown;
		try {
			await adapter().updateMemory(store.id, memory.id, { content: "new", expected_content_sha256: "old" });
		} catch (error) {
			failure = error;
		}
		expect(failure).toBeInstanceOf(ApiError);
		expect((failure as ApiError).responseBody).toBe(body);
		expect((failure as ApiError).statusCode).toBe(409);
		expect(calls).toHaveLength(1);
	});
});

describe("Bailian Memory lifecycle comparison", () => {
	test("compares display attributes and declared metadata only, preserving ID-only identity", async () => {
		const provider = adapter();
		const calls = responses([{ ...store, entry_count: 900, entries: [{ content: "runtime" }] }]);
		const declaration = { name: store.name, description: store.description, metadata: { team: "data" } };
		expect(provider.getDriftSupport("memory_store")).toBe("full");
		expect(BAILIAN_CAPABILITIES.memory_store.tier).toBe("native");
		expect(await provider.readComparableResource("memory_store", null, store.name, declaration)).toBeNull();
		expect(calls).toHaveLength(0);
		const remote = await provider.readComparableResource("memory_store", store.id, "logical-key", declaration);
		const desired = provider.normalizeDesiredResource("memory_store", "logical-key", declaration);
		expect(remote?.comparable).toEqual(desired);
		expect(remote?.comparable).toEqual({
			name: store.name,
			description: store.description,
			metadata: { team: "data" },
		});
	});

	test("treats archived stores as absent for drift while direct API reads remain available", async () => {
		const archived = { ...store, archived_at: "2026-10-13T01:00:00Z" };
		responses([archived, archived]);
		const provider = adapter();
		expect(await provider.readComparableResource("memory_store", store.id, store.name)).toBeNull();
		expect(await provider.getMemoryStore(store.id)).toEqual(archived);
	});
});
