import { afterEach, describe, expect, test } from "bun:test";
import { setDefaultFetch } from "../../src/index.ts";
import type { ProjectRuntimeContext } from "../../src/internal/core/project-runtime.ts";
import { importResource } from "../../src/internal/core/resource-runtime.ts";
import { executePlan } from "../../src/internal/executor/executor.ts";
import { buildPlan } from "../../src/internal/planner/planner.ts";
import { refreshState } from "../../src/internal/planner/refresh.ts";
import { BailianAdapter } from "../../src/internal/providers/bailian/adapter.ts";
import { InMemoryStateManager } from "../../src/internal/state/in-memory-state-manager.ts";
import type { MemoryStoreDecl, ResolvedProjectConfig } from "../../src/internal/types/config.ts";
import { sha256 } from "../../src/internal/utils/hash.ts";

const address = { provider: "bailian", type: "memory_store" as const, name: "notes" };
const entries = [
	{ key: "notes/first.md", content: "Managed first body, never persist in State" },
	{ key: "/notes/second.md", content: "Managed second body, never persist in State" },
];

afterEach(() => setDefaultFetch(undefined));

function fixture(entriesMode: MemoryStoreDecl["entries_mode"] = "sync") {
	const calls: Array<{ method: string; path: string; page: string | null; view: string | null; limit: string | null }> =
		[];
	const memories = new Map<string, { id: string; content: string }>();
	const control = { repeatCursor: false };
	const remoteStore = {
		id: "memstore_notes",
		type: "memory_store",
		name: "notes",
		description: "Notes",
		metadata: {},
		archived_at: null,
	};
	let memorySequence = 0;
	setDefaultFetch(async (input, init) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		const path = url.pathname.replace("/api/v1/agentstudio", "");
		const rawBody = await request.text();
		const body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : undefined;
		calls.push({
			method: request.method,
			path,
			page: url.searchParams.get("page"),
			view: url.searchParams.get("view"),
			limit: url.searchParams.get("limit"),
		});
		if (path === "/memory_stores" && request.method === "POST") return Response.json(remoteStore);
		if (path === "/memory_stores/memstore_notes") {
			if (request.method === "POST") Object.assign(remoteStore, body);
			return Response.json(remoteStore);
		}
		if (path === "/memory_stores/memstore_notes/memories") {
			if (request.method === "POST") {
				const memoryPath = body!.path as string;
				memories.set(memoryPath, { id: `mem_${++memorySequence}`, content: body!.content as string });
				return Response.json({ id: memories.get(memoryPath)!.id, type: "memory", path: memoryPath });
			}
			const limit = Number(url.searchParams.get("limit"));
			if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
				return Response.json({ message: "limit must be between 1 and 20" }, { status: 400 });
			}
			const all = [...memories.entries()].map(([memoryPath, memory]) => ({
				id: memory.id,
				type: "memory",
				path: memoryPath,
				content_sha256: sha256(memory.content),
				// Even an unexpectedly verbose basic view must not leak bodies into State.
				content: memory.content,
			}));
			const offset = Number(url.searchParams.get("page")?.replace("opaque page +/", "") ?? 0);
			return Response.json({
				data: all.slice(offset, offset + 1),
				next_page: control.repeatCursor
					? "opaque page +/1"
					: offset + 1 < all.length
						? `opaque page +/${offset + 1}`
						: null,
			});
		}
		const memoryId = path.split("/").at(-1);
		for (const [memoryPath, memory] of memories) {
			if (request.method === "POST" && memory.id === memoryId && body) {
				memory.content = body.content as string;
				return Response.json({
					id: memory.id,
					type: "memory",
					path: memoryPath,
					content_sha256: sha256(memory.content),
				});
			}
		}
		throw new Error(`Unexpected mocked request: ${request.method} ${path}`);
	});
	const provider = new BailianAdapter("test-key", "workspace", "https://workspace.example/api/v1/agentstudio");
	const config: ResolvedProjectConfig = {
		version: "1",
		_resolved: true,
		providers: { bailian: { api_key: "test-key", workspace_id: "workspace" } },
		defaults: { provider: "bailian" },
		memory_stores: { notes: { description: "Notes", entries_mode: entriesMode, entries: structuredClone(entries) } },
	};
	const runtime: ProjectRuntimeContext = {
		config,
		configPath: "/tmp/memory-sync-drift-agents.yaml",
		projectName: "memory-sync-drift",
		providers: new Map([["bailian", provider]]),
		state: InMemoryStateManager.empty(),
	};
	const plan = () => buildPlan(config, runtime.state.getStateFile());
	async function apply() {
		return executePlan(await plan(), runtime);
	}
	async function refresh() {
		const result = await refreshState(runtime.state, runtime.providers, { config, quiet: true });
		expect(result.errors).toEqual([]);
		return plan();
	}
	return { runtime, provider, calls, memories, control, plan, apply, refresh };
}

describe("Bailian explicit Memory sync drift", () => {
	test.each([
		"modified",
		"deleted",
	])("restores a declared path remotely %s and follows native pagination", async (change) => {
		const current = fixture();
		expect((await current.apply()).partial).toBe(false);
		if (change === "modified") current.memories.get("/notes/second.md")!.content = "Remote edit";
		else current.memories.delete("/notes/second.md");
		current.calls.length = 0;
		const plan = await current.refresh();
		expect(plan.actions[0]?.action).toBe("update");
		expect(plan.actions[0]?.driftKind).toBe("remote");
		expect((await current.apply()).partial).toBe(false);
		expect(current.memories.get("/notes/second.md")?.content).toBe(entries[1]!.content);
		expect((await current.refresh()).actions[0]?.action).toBe("no-op");
		const memoryReads = current.calls.filter((call) => call.method === "GET" && call.path.endsWith("/memories"));
		expect(memoryReads.every((call) => call.view === "basic")).toBe(true);
		expect(memoryReads.every((call) => call.limit === "20")).toBe(true);
		expect(memoryReads.some((call) => call.page === "opaque page +/1")).toBe(true);
		const serialized = JSON.stringify(current.runtime.state.getStateFile());
		for (const entry of entries) expect(serialized).not.toContain(entry.content);
		expect(serialized).not.toContain("Remote edit");
		expect(current.runtime.state.getResource(address)?.remote_snapshot).toMatchObject({
			entry_hashes: {
				"/notes/first.md": sha256(entries[0]!.content),
				"/notes/second.md": sha256(entries[1]!.content),
			},
		});
	});

	test("imports matching store attributes, then syncs missing declared paths on apply", async () => {
		const current = fixture();
		const imported = await importResource(current.runtime, address, "memstore_notes");
		expect(imported.drift_status).toBe("drifted");
		expect(imported.remote_snapshot).toMatchObject({
			entry_hashes: { "/notes/first.md": null, "/notes/second.md": null },
		});
		expect(current.calls.every((call) => call.method === "GET")).toBe(true);
		expect(current.memories.size).toBe(0);
		expect((await current.refresh()).actions[0]?.action).toBe("update");
		expect((await current.apply()).partial).toBe(false);
		expect(current.memories.get("/notes/first.md")?.content).toBe(entries[0]!.content);
		expect(current.memories.get("/notes/second.md")?.content).toBe(entries[1]!.content);
		expect((await current.refresh()).actions[0]?.action).toBe("no-op");
	});

	test("ignores creation, changes and deletion of undeclared paths", async () => {
		const current = fixture();
		await current.apply();
		current.memories.set("/runtime.md", { id: "mem_runtime", content: "Runtime-only body" });
		expect((await current.refresh()).actions[0]?.action).toBe("no-op");
		current.memories.get("/runtime.md")!.content = "Changed runtime body";
		expect((await current.refresh()).actions[0]?.action).toBe("no-op");
		expect(JSON.stringify(current.runtime.state.getStateFile())).not.toContain("runtime.md");
		current.memories.delete("/runtime.md");
		expect((await current.refresh()).actions[0]?.action).toBe("no-op");
	});

	test("does not list bodies when refreshing or importing in initialize mode", async () => {
		const current = fixture("initialize");
		await current.apply();
		current.calls.length = 0;
		current.memories.get("/notes/second.md")!.content = "Runtime edited initializer";
		expect((await current.refresh()).actions[0]?.action).toBe("no-op");
		current.runtime.state.removeResource(address);
		const imported = await importResource(current.runtime, address, "memstore_notes");
		expect(imported.drift_status).toBe("in_sync");
		expect(current.calls.some((call) => call.path.endsWith("/memories"))).toBe(false);
		expect(imported.remote_snapshot).not.toHaveProperty("entry_hashes");
	});

	test("rejects repeated native page cursors before importing state", async () => {
		const current = fixture();
		current.control.repeatCursor = true;
		await expect(importResource(current.runtime, address, "memstore_notes")).rejects.toThrow("repeated cursor");
		expect(current.runtime.state.getResource(address)).toBeUndefined();
		expect(current.calls.filter((call) => call.path.endsWith("/memories"))).toHaveLength(2);
	});
});
