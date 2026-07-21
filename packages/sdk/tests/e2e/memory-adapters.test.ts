import { afterEach, expect, test } from "bun:test";
import { ArkAdapter } from "../../src/internal/providers/ark/adapter.ts";
import { ClaudeAdapter } from "../../src/internal/providers/claude/adapter.ts";
import { QoderAdapter } from "../../src/internal/providers/qoder/adapter.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

const memory = {
	id: "mem_1",
	type: "memory",
	memory_store_id: "memstore_1",
	path: "notes/a.md",
	content: "hello",
	content_size_bytes: 5,
	content_sha256: "sha",
	created_at: "2026-01-01T00:00:00Z",
	updated_at: "2026-01-01T00:00:00Z",
};

test("Claude memory requests include the memory beta and absolute wire paths", async () => {
	let request: Request | undefined;
	globalThis.fetch = async (input, init) => {
		request = new Request(input, init);
		return Response.json({ ...memory, path: "/notes/a.md" });
	};
	const adapter = new ClaudeAdapter("test-key");
	const result = await adapter.createMemory("memstore_1", { path: "notes/a.md", content: "hello" });
	expect(request?.headers.get("anthropic-beta")).toContain("agent-memory-2026-07-22");
	expect(await request?.json()).toEqual({ path: "/notes/a.md", content: "hello" });
	expect(result.path).toBe("notes/a.md");
});

test("Claude memory prefix filtering uses path_prefix", async () => {
	let request: Request | undefined;
	globalThis.fetch = async (input, init) => {
		request = new Request(input, init);
		return Response.json({ data: [], next_page: null });
	};
	const adapter = new ClaudeAdapter("test-key");
	await adapter.listMemories("memstore_1", { prefix: "notes/" });
	expect(request?.url).toContain("path_prefix=%2Fnotes%2F");
	expect(request?.url).not.toContain("?prefix=");
});

test("Ark batch create uses batch_create and preserves partial failures", async () => {
	let request: Request | undefined;
	globalThis.fetch = async (input, init) => {
		request = new Request(input, init);
		return Response.json({
			results: [
				{ path: "a.md", memory },
				{ path: "b.md", error: { type: "conflict_error", message: "exists" } },
			],
		});
	};
	const adapter = new ArkAdapter("test-key");
	const result = await adapter.batchCreateMemories("memstore-1", {
		items: [
			{ path: "a.md", content: "a" },
			{ path: "b.md", content: "b" },
		],
		on_conflict: "fail",
	});
	expect(request?.url).toEndWith("/memory_stores/memstore-1/memories/batch_create");
	expect(result.results[1]?.error?.type).toBe("conflict_error");
});

test("Qoder updates memory with its documented POST contract", async () => {
	let request: Request | undefined;
	globalThis.fetch = async (input, init) => {
		request = new Request(input, init);
		return Response.json(memory);
	};
	const adapter = new QoderAdapter("test-key");
	await adapter.updateMemory("memstore_1", "mem_1", {
		content: "new",
		path: "renamed.md",
		metadata: { source: "test" },
		expected_content_sha256: "old",
	});
	expect(request?.method).toBe("POST");
	expect(await request?.json()).toEqual({
		content: "new",
		metadata: { source: "test" },
		content_sha256: "old",
	});
});

test("Qoder translates replacement metadata into its merge-patch contract", async () => {
	const requests: Request[] = [];
	globalThis.fetch = async (input, init) => {
		requests.push(new Request(input, init));
		return Response.json({
			id: "memstore_1",
			type: "memory_store",
			name: "notes",
			description: "notes",
			metadata: requests.length === 1 ? { keep: "old", drop: "old" } : { keep: "new" },
			created_at: "2026-01-01T00:00:00Z",
			updated_at: "2026-01-01T00:00:00Z",
		});
	};
	const adapter = new QoderAdapter("test-key");
	await adapter.updateMemoryStore("memstore_1", { metadata: { keep: "new" } });
	expect(requests[0]?.method).toBe("GET");
	expect(requests[1]?.method).toBe("POST");
	expect(await requests[1]?.json()).toEqual({ metadata: { keep: "new", drop: null } });
});

test("Qoder exposes documented version routes and fields through the portable adapter", async () => {
	const requests: Request[] = [];
	const versionResponse = {
		id: "memver_1",
		type: "memory_version",
		store_id: "memstore_1",
		entry_id: "mem_1",
		entry_path: "notes/a.md",
		action: "updated",
		created_at: "2026-01-01T00:00:00Z",
	};
	globalThis.fetch = async (input, init) => {
		requests.push(new Request(input, init));
		return Response.json(requests.length === 1 ? versionResponse : { data: [versionResponse], has_more: false });
	};
	const adapter = new QoderAdapter("test-key");
	const version = await adapter.getMemoryVersion("memstore_1", "memver_1");
	const versions = await adapter.listMemoryVersions("memstore_1");
	expect(requests[0]?.url).toEndWith("/memory_stores/memstore_1/versions/memver_1");
	expect(requests[1]?.url).toEndWith("/memory_stores/memstore_1/versions");
	expect(version.memory_id).toBe("mem_1");
	expect(version.path).toBe("notes/a.md");
	expect(version.operation).toBe("updated");
	expect(versions.data[0]?.memory_id).toBe("mem_1");
});
