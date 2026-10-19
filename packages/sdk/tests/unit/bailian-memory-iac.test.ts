import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiError, setDefaultFetch } from "../../src/index.ts";
import type { ProjectRuntimeContext } from "../../src/internal/core/project-runtime.ts";
import { importResource, planProjectContext } from "../../src/internal/core/resource-runtime.ts";
import { executePlan } from "../../src/internal/executor/executor.ts";
import { computeResourceHash } from "../../src/internal/planner/hasher.ts";
import { buildPlan } from "../../src/internal/planner/planner.ts";
import { refreshState } from "../../src/internal/planner/refresh.ts";
import { BailianAdapter } from "../../src/internal/providers/bailian/adapter.ts";
import { StateManager } from "../../src/internal/state/state-manager.ts";
import type { MemoryStoreDecl, ResolvedProjectConfig } from "../../src/internal/types/config.ts";
import { sha256 } from "../../src/internal/utils/hash.ts";

const directories: string[] = [];
const address = { provider: "bailian", type: "memory_store" as const, name: "notes" };
const originalEntries = [
	{ key: "notes/first.md", content: "Original initializer one" },
	{ key: "/notes/second.md", content: "Original initializer two" },
];

afterEach(async () => {
	setDefaultFetch(undefined);
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(
	declaration: MemoryStoreDecl = { name: "Shared notes", description: "Notes", entries: originalEntries },
) {
	const directory = await mkdtemp(join(tmpdir(), "bailian-memory-iac-"));
	directories.push(directory);
	const statePath = join(directory, "state.json");
	const state = StateManager.initialize(statePath);
	const calls: Array<{
		method: string;
		path: string;
		body?: Record<string, unknown>;
		limit: string | null;
		page: string | null;
	}> = [];
	const memories = new Map<string, { id: string; content: string }>();
	let storeCount = 0;
	const remoteStore = {
		id: "memstore_1",
		type: "memory_store",
		name: "Shared notes",
		description: "Notes",
		metadata: {} as Record<string, unknown>,
		archived_at: null as string | null,
		created_at: "2026-10-13T00:00:00Z",
		updated_at: "2026-10-13T00:00:00Z",
	};
	const control = {
		failPath: undefined as string | undefined,
		failArchive: false,
		imported: false,
		missingStoreIds: new Set<string>(),
		deleteMemoryOnUpdate: false,
		memoryDeleted: false,
		storeReadStatusAfterMemoryDelete: undefined as number | undefined,
	};
	setDefaultFetch(async (input, init) => {
		const request = new Request(input, init);
		const url = new URL(request.url);
		const path = url.pathname.replace("/api/v1/agentstudio", "");
		const rawBody = await request.text();
		const body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : undefined;
		calls.push({
			method: request.method,
			path,
			body,
			limit: url.searchParams.get("limit"),
			page: url.searchParams.get("page"),
		});
		if (path === "/memory_stores" && request.method === "POST") {
			storeCount++;
			Object.assign(remoteStore, body, { id: `memstore_${storeCount}`, archived_at: null });
			return Response.json(remoteStore);
		}
		if (path.endsWith("/archive")) {
			if (control.failArchive) return Response.json({ error: { message: "archive unavailable" } }, { status: 503 });
			remoteStore.archived_at = "2026-10-13T01:00:00Z";
			return Response.json(remoteStore);
		}
		if (path.match(/^\/memory_stores\/[^/]+$/)) {
			if ((!storeCount && !control.imported) || control.missingStoreIds.has(path.split("/").at(-1)!)) {
				return Response.json({ error: { message: "missing" } }, { status: 404 });
			}
			if (request.method === "GET" && control.memoryDeleted && control.storeReadStatusAfterMemoryDelete) {
				return Response.json(
					{ error: { message: "store lookup unavailable" } },
					{ status: control.storeReadStatusAfterMemoryDelete },
				);
			}
			if (request.method === "POST") Object.assign(remoteStore, body);
			return Response.json(remoteStore);
		}
		if (path.endsWith("/memories") && request.method === "POST") {
			const memoryPath = body!.path as string;
			if (control.failPath === memoryPath)
				return Response.json({ error: { message: "seed unavailable" } }, { status: 503 });
			memories.set(memoryPath, { id: `mem_${memories.size + 1}`, content: body!.content as string });
			return Response.json({ id: memories.get(memoryPath)!.id, type: "memory", path: memoryPath });
		}
		if (path.endsWith("/memories")) {
			const limit = Number(url.searchParams.get("limit"));
			if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
				return Response.json({ message: "limit must be between 1 and 20" }, { status: 400 });
			}
			const all = [...memories.entries()].map(([memoryPath, memory]) => ({
				id: memory.id,
				type: "memory",
				path: memoryPath,
				content_sha256: sha256(memory.content),
			}));
			const secondPage = url.searchParams.get("page") === "second-page";
			return Response.json({
				data: secondPage ? all.slice(1) : all.slice(0, 1),
				next_page: !secondPage && all.length > 1 ? "second-page" : null,
			});
		}
		const memoryId = path.split("/").at(-1);
		for (const [memoryPath, memory] of memories) {
			if (memory.id === memoryId && body) {
				if (control.deleteMemoryOnUpdate) {
					memories.delete(memoryPath);
					control.memoryDeleted = true;
					return Response.json({ error: { message: "memory disappeared before update" } }, { status: 404 });
				}
				memory.content = body.content as string;
				return Response.json({
					id: memoryId,
					type: "memory",
					path: memoryPath,
					content_sha256: sha256(memory.content),
				});
			}
		}
		throw new Error(`Unexpected request ${request.method} ${path}`);
	});
	const provider = new BailianAdapter(
		"test-key",
		"workspace",
		"https://workspace.example/api/v1/agentstudio",
		"project",
	);
	const config: ResolvedProjectConfig = {
		version: "1",
		_resolved: true,
		providers: { bailian: { api_key: "test-key", workspace_id: "workspace" } },
		defaults: { provider: "bailian" },
		memory_stores: { notes: structuredClone(declaration) },
	};
	const runtime: ProjectRuntimeContext = {
		configPath: join(directory, "agents.yaml"),
		projectName: "project",
		config,
		state,
		providers: new Map([["bailian", provider]]),
	};
	async function apply() {
		const plan = await buildPlan(config, runtime.state.getStateFile());
		return executePlan(plan, runtime);
	}
	return { runtime, apply, calls, memories, control, remoteStore, statePath, provider, createdCount: () => storeCount };
}

describe("Bailian Memory Store IaC", () => {
	test("saves the new ID before a seed request and resumes missing paths without overwriting Agent content", async () => {
		const current = await fixture();
		current.control.failPath = "/notes/second.md";
		const first = await current.apply();
		expect(first.partial).toBe(true);
		expect(first.results[0]?.error?.message).toContain("seed unavailable");
		const checkpoint = await StateManager.load(current.statePath);
		expect(checkpoint.getResource(address)?.remote_id).toBe("memstore_1");
		expect(checkpoint.getResource(address)?.memory_initialization?.pending_entries).toEqual([
			{ path: "/notes/second.md", content_sha256: sha256(originalEntries[1]!.content) },
		]);
		expect(await readFile(current.statePath, "utf8")).not.toContain(originalEntries[0]!.content);
		current.memories.get("/notes/first.md")!.content = "Agent's newer content";
		current.memories.set("/notes/second.md", { id: "mem_agent", content: "Agent wrote the pending path" });
		current.control.failPath = undefined;
		current.runtime.state = checkpoint;
		const scoped = await planProjectContext(current.runtime, {
			refresh: false,
			mode: "create-only",
			scope: { roots: [address] },
		});
		expect(scoped.plan.diagnostics.filter((diagnostic) => diagnostic.severity === "error")).toEqual([]);
		expect(scoped.plan.actions[0]?.action).toBe("update");
		expect((await current.apply()).partial).toBe(false);
		expect(current.createdCount()).toBe(1);
		expect(current.memories.get("/notes/first.md")?.content).toBe("Agent's newer content");
		expect(current.memories.get("/notes/second.md")?.content).toBe("Agent wrote the pending path");
		expect(current.runtime.state.getResource(address)?.memory_initialization).toBeUndefined();
		const memoryReads = current.calls.filter((call) => call.method === "GET" && call.path.endsWith("/memories"));
		expect(memoryReads.every((call) => call.limit === "20")).toBe(true);
		expect(memoryReads.some((call) => call.page === "second-page")).toBe(true);
		current.memories.delete("/notes/first.md");
		current.runtime.config.memory_stores!.notes!.entries!.push({ key: "new.md", content: "Later initializer" });
		await current.apply();
		expect(current.memories.has("/notes/first.md")).toBe(false);
		expect(current.memories.has("/new.md")).toBe(false);
	});

	test("refuses changed pending initializer content without creating another store", async () => {
		const current = await fixture({ description: "Notes", entries: originalEntries.map((entry) => ({ ...entry })) });
		current.control.failPath = "/notes/second.md";
		await current.apply();
		current.runtime.config.memory_stores!.notes!.entries![1]!.content = "Changed pending body";
		current.control.failPath = undefined;
		const result = await current.apply();
		expect(result.partial).toBe(true);
		expect(result.results[0]?.error?.message).toContain("Restore its original content");
		expect(current.createdCount()).toBe(1);
		expect(current.memories.has("/notes/second.md")).toBe(false);
	});

	test("updates properties while preserving undeclared metadata and runtime files", async () => {
		const current = await fixture({ description: "Notes", metadata: { owned: "old" }, entries: [] });
		await current.apply();
		current.remoteStore.metadata.external = { retained: true };
		current.memories.set("/runtime.md", { id: "mem_runtime", content: "Learned" });
		current.runtime.config.memory_stores!.notes = {
			name: "Renamed display",
			description: "New description",
			metadata: { owned: "new" },
			entries: [{ key: "runtime.md", content: "Old seed" }],
		};
		const result = await current.apply();
		expect(result.partial).toBe(false);
		expect(current.remoteStore.name).toBe("Renamed display");
		expect(current.remoteStore.metadata).toEqual({ owned: "new", external: { retained: true } });
		expect(current.memories.get("/runtime.md")?.content).toBe("Learned");
	});

	test("explicit sync uses absolute paths and SHA preconditions", async () => {
		const current = await fixture({ description: "Notes", entries: [{ key: "note.md", content: "Original" }] });
		await current.apply();
		current.memories.get("/note.md")!.content = "Agent changed";
		current.runtime.config.memory_stores!.notes = {
			description: "Notes",
			entries_mode: "sync",
			entries: [{ key: "note.md", content: "Managed" }],
		};
		expect((await current.apply()).partial).toBe(false);
		expect(current.memories.get("/note.md")?.content).toBe("Managed");
		expect(current.calls.find((call) => call.path.endsWith("/memories/mem_1"))?.body).toEqual({
			content: "Managed",
			precondition: { type: "content_sha256", content_sha256: sha256("Agent changed") },
		});
	});

	test.each([
		undefined,
		503,
	])("preserves the Store ID after a concurrent file deletion with Store confirmation status %p", async (storeReadStatus) => {
		const current = await fixture({ description: "Notes", entries: [{ key: "note.md", content: "Original" }] });
		await current.apply();
		const previousState = structuredClone(current.runtime.state.getResource(address));
		current.runtime.config.memory_stores!.notes = {
			description: "Notes",
			entries_mode: "sync",
			entries: [{ key: "note.md", content: "Managed" }],
		};
		current.control.deleteMemoryOnUpdate = true;
		current.control.storeReadStatusAfterMemoryDelete = storeReadStatus;

		const result = await current.apply();

		expect(result.partial).toBe(true);
		expect(result.results[0]?.error).toBeInstanceOf(ApiError);
		expect(result.results[0]?.error).toMatchObject({ statusCode: storeReadStatus ?? 404 });
		expect(result.results[0]?.error?.message).toContain(
			storeReadStatus ? "store lookup unavailable" : "memory disappeared before update",
		);
		expect(current.control.memoryDeleted).toBe(true);
		expect(current.createdCount()).toBe(1);
		expect(current.runtime.state.getResource(address)).toEqual(previousState);
		expect((await StateManager.load(current.statePath)).getResource(address)).toEqual(previousState);
		expect(current.calls.at(-1)).toMatchObject({ method: "GET", path: "/memory_stores/memstore_1" });
	});

	test("recreates a Store only after its own lookup confirms the missing ID", async () => {
		const current = await fixture({ description: "Notes" });
		await current.apply();
		current.control.missingStoreIds.add("memstore_1");
		current.runtime.config.memory_stores!.notes!.description = "Changed";
		const callOffset = current.calls.length;

		const result = await current.apply();

		expect(result.partial).toBe(false);
		expect(current.createdCount()).toBe(2);
		expect(current.runtime.state.getResource(address)?.remote_id).toBe("memstore_2");
		expect((await StateManager.load(current.statePath)).getResource(address)?.remote_id).toBe("memstore_2");
		expect(current.calls.slice(callOffset, callOffset + 3).map(({ method, path }) => ({ method, path }))).toEqual([
			{ method: "GET", path: "/memory_stores/memstore_1" },
			{ method: "GET", path: "/memory_stores/memstore_1" },
			{ method: "POST", path: "/memory_stores" },
		]);
	});

	test("imports by ID without seeds and plans only property differences", async () => {
		const current = await fixture({ name: "Desired name", description: "Desired", entries: originalEntries });
		current.control.imported = true;
		const imported = await importResource(current.runtime, address, "memstore_1");
		expect(imported.memory_initialization).toBeUndefined();
		expect(imported.drift_status).toBe("drifted");
		expect(current.calls.every((call) => call.method === "GET")).toBe(true);
		const plan = await buildPlan(current.runtime.config, current.runtime.state.getStateFile());
		expect(plan.actions[0]?.action).toBe("update");
		await current.apply();
		expect(current.memories.size).toBe(0);
		expect(current.createdCount()).toBe(0);
	});

	test("rejects missing, archived and duplicate-ID imports without writing the target state", async () => {
		const current = await fixture({ description: "Notes" });
		await expect(importResource(current.runtime, address, "missing")).rejects.toThrow("404");
		current.control.imported = true;
		current.remoteStore.archived_at = "2026-10-13T00:00:00Z";
		await expect(importResource(current.runtime, address, "memstore_1")).rejects.toThrow("archived");
		current.remoteStore.archived_at = null;
		current.runtime.state.setResource({
			address: { ...address, name: "other" },
			remote_id: "memstore_1",
			content_hash: "old",
		});
		await expect(importResource(current.runtime, address, "memstore_1")).rejects.toThrow("already bound");
		expect(current.runtime.state.getResource(address)).toBeUndefined();
	});

	test("archives on delete, retaining State when archive fails", async () => {
		const current = await fixture({ description: "Notes" });
		await current.apply();
		delete current.runtime.config.memory_stores!.notes;
		const plan = await buildPlan(current.runtime.config, current.runtime.state.getStateFile());
		expect(plan.actions[0]?.reason).toContain("Archive Memory Store");
		current.control.failArchive = true;
		expect((await executePlan(plan, current.runtime)).partial).toBe(true);
		expect(current.runtime.state.getResource(address)?.remote_id).toBe("memstore_1");
		current.control.failArchive = false;
		expect((await executePlan(plan, current.runtime)).partial).toBe(false);
		expect(current.runtime.state.getResource(address)).toBeUndefined();
		expect(current.remoteStore.archived_at).not.toBeNull();
	});

	test("refresh ignores runtime content and undeclared metadata changes", async () => {
		const current = await fixture({ description: "Notes", metadata: { owned: "same" } });
		await current.apply();
		current.remoteStore.metadata.extra = "Unmanaged";
		current.memories.set("/runtime.md", { id: "mem_runtime", content: "Learned" });
		await refreshState(current.runtime.state, current.runtime.providers, {
			config: current.runtime.config,
			quiet: true,
		});
		const plan = await buildPlan(current.runtime.config, current.runtime.state.getStateFile());
		expect(plan.actions[0]?.action).toBe("no-op");
		const hash = await computeResourceHash(address, current.runtime.config);
		expect(current.runtime.state.getResource(address)?.desired_hash).toBe(hash);
	});
});
