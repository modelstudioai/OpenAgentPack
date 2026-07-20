import { describe, expect, test } from "bun:test";
import { BaseApiClient } from "../../src/internal/providers/base-client.ts";
import { ProviderMemoryApi } from "../../src/internal/providers/memory-api.ts";

class FakeClient extends BaseApiClient {
	protected baseUrl = "https://example.test";
	protected errorPrefix = "test";
	protected paginationStrategy = "page" as const;
	requests: Array<{ method: string; path: string; body?: unknown }> = [];
	responses: unknown[] = [];
	protected headers() {
		return {};
	}
	override async get(path: string) {
		this.requests.push({ method: "GET", path });
		return this.responses.shift();
	}
	override async post(path: string, body: unknown) {
		this.requests.push({ method: "POST", path, body });
		return this.responses.shift();
	}
	override async delete(path: string) {
		this.requests.push({ method: "DELETE", path });
	}
}

const memoryResponse = {
	id: "mem_1",
	type: "memory",
	memory_store_id: "memstore_1",
	path: "/notes/a.md",
	content: "hello",
	content_size_bytes: 5,
	content_sha256: "sha",
	metadata: {},
	created_at: "2026-01-01T00:00:00Z",
	updated_at: "2026-01-01T00:00:00Z",
};

describe("ProviderMemoryApi", () => {
	test("normalizes Claude absolute paths to portable relative paths", async () => {
		const client = new FakeClient();
		client.responses.push(memoryResponse);
		const api = new ProviderMemoryApi(client, {
			pathStyle: "absolute",
			cursorParam: "page",
			updatePrecondition: "precondition",
			prefixParam: "prefix",
			supportsView: true,
			supportsMemoryMetadata: false,
			supportsDeletePrecondition: true,
			supportsIncludeArchived: true,
		});
		const result = await api.createMemory("memstore_1", { path: "notes/a.md", content: "hello" });
		expect(client.requests[0]).toEqual({
			method: "POST",
			path: "/memory_stores/memstore_1/memories",
			body: { path: "/notes/a.md", content: "hello" },
		});
		expect(result.path).toBe("notes/a.md");
	});

	test("maps the portable optimistic concurrency field to Claude precondition", async () => {
		const client = new FakeClient();
		client.responses.push(memoryResponse);
		const api = new ProviderMemoryApi(client, {
			pathStyle: "absolute",
			cursorParam: "page",
			updatePrecondition: "precondition",
			prefixParam: "prefix",
			supportsView: true,
			supportsMemoryMetadata: false,
			supportsDeletePrecondition: true,
			supportsIncludeArchived: true,
		});
		await api.updateMemory("memstore_1", "mem_1", { content: "hello", expected_content_sha256: "old" });
		expect(client.requests[0]?.body).toEqual({
			content: "hello",
			precondition: { type: "content_sha256", content_sha256: "old" },
		});
	});

	test("maps Qoder fields and after_id pagination", async () => {
		const client = new FakeClient();
		client.responses.push({
			data: [{ ...memoryResponse, path: "notes/a.md", store_id: "memstore_1", size: 5 }],
			has_more: true,
			last_id: "mem_1",
		});
		const api = new ProviderMemoryApi(client, {
			pathStyle: "relative",
			cursorParam: "after_id",
			updatePrecondition: "content_sha256",
			prefixParam: "prefix",
			supportsView: false,
			supportsMemoryMetadata: true,
			supportsDeletePrecondition: false,
			supportsIncludeArchived: true,
		});
		const result = await api.listMemories("memstore_1", { limit: 10, cursor: "mem_0", view: "full" });
		expect(client.requests[0]?.path).toBe("/memory_stores/memstore_1/memories?limit=10&after_id=mem_0");
		expect(result.next_cursor).toBe("mem_1");
		expect(result.data[0]?.path).toBe("notes/a.md");
	});

	test("normalizes modified version operation", async () => {
		const client = new FakeClient();
		client.responses.push({
			id: "memver_1",
			type: "memory_version",
			memory_store_id: "memstore_1",
			memory_id: "mem_1",
			path: "/notes/a.md",
			operation: "modified",
			created_at: "2026-01-01T00:00:00Z",
		});
		const api = new ProviderMemoryApi(client, {
			pathStyle: "absolute",
			cursorParam: "page",
			updatePrecondition: "precondition",
			prefixParam: "prefix",
			supportsView: true,
			supportsMemoryMetadata: false,
			supportsDeletePrecondition: true,
			supportsIncludeArchived: true,
		});
		const result = await api.getVersion("memstore_1", "memver_1");
		expect(result.operation).toBe("updated");
		expect(result.path).toBe("notes/a.md");
	});

	test("maps Ark pagination, path_prefix and last-write-wins updates", async () => {
		const client = new FakeClient();
		client.responses.push({ data: [], next_page: "page_2" }, memoryResponse);
		const api = new ProviderMemoryApi(client, {
			pathStyle: "relative",
			cursorParam: "page",
			updatePrecondition: "none",
			prefixParam: "path_prefix",
			supportsView: false,
			supportsMemoryMetadata: false,
			supportsDeletePrecondition: false,
			supportsIncludeArchived: false,
		});
		const listed = await api.listMemories("memstore-1", { cursor: "page_1", prefix: "notes/" });
		expect(client.requests[0]?.path).toBe("/memory_stores/memstore-1/memories?page=page_1&path_prefix=notes%2F");
		expect(listed.next_cursor).toBe("page_2");
		await api.updateMemory("memstore-1", "mem-1", { content: "new", expected_content_sha256: "ignored-on-ark" });
		expect(client.requests[1]?.body).toEqual({ content: "new" });
	});

	test("maps Ark batch create partial results", async () => {
		const client = new FakeClient();
		client.responses.push({
			results: [
				{ path: "a.md", memory: { ...memoryResponse, path: "a.md" } },
				{ path: "b.md", error: { type: "conflict_error", message: "exists" } },
			],
		});
		const api = new ProviderMemoryApi(client, {
			pathStyle: "relative",
			cursorParam: "page",
			updatePrecondition: "none",
			prefixParam: "path_prefix",
			supportsView: false,
			supportsMemoryMetadata: false,
			supportsDeletePrecondition: false,
			supportsIncludeArchived: false,
		});
		const result = await api.batchCreateMemories("memstore-1", {
			items: [
				{ path: "a.md", content: "a" },
				{ path: "b.md", content: "b" },
			],
			on_conflict: "fail",
		});
		expect(client.requests[0]).toEqual({
			method: "POST",
			path: "/memory_stores/memstore-1/memories/batch_create",
			body: {
				items: [
					{ path: "a.md", content: "a" },
					{ path: "b.md", content: "b" },
				],
				on_conflict: "fail",
			},
		});
		expect(result.results[1]?.error?.type).toBe("conflict_error");
	});
});
