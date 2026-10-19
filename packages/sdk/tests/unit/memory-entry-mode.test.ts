import { afterEach, expect, test } from "bun:test";
import { projectConfigSchema } from "../../src/internal/parser/schema.ts";
import { ArkAdapter } from "../../src/internal/providers/ark/adapter.ts";

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

const entries = [
	{ key: "notes/project.md", content: "Initial project notes" },
	{ key: "notes/preferences.md", content: "Initial preferences" },
];

function memoryProject(entriesMode?: unknown) {
	return {
		version: "1",
		providers: { ark: {} },
		memory_stores: {
			notes: {
				description: "Project notes",
				metadata: { owner: "test" },
				entries,
				...(entriesMode === undefined ? {} : { entries_mode: entriesMode }),
			},
		},
	};
}

const supportedModes = [
	{ label: "omitted", entriesMode: undefined },
	{ label: "initialize", entriesMode: "initialize" },
	{ label: "sync", entriesMode: "sync" },
];

test.each(supportedModes)("parses $label memory entries mode without injecting a default", ({ entriesMode }) => {
	const config = projectConfigSchema.parse(memoryProject(entriesMode));
	const declaration = config.memory_stores?.notes;

	expect(declaration).toEqual(memoryProject(entriesMode).memory_stores.notes);
	expect(declaration?.entries).toEqual(entries);
	expect(Object.hasOwn(declaration!, "entries_mode")).toBe(entriesMode !== undefined);
});

test.each(["replace", "", null, true, 1])("rejects invalid memory entries mode %p", (entriesMode) => {
	const result = projectConfigSchema.safeParse(memoryProject(entriesMode));

	expect(result.success).toBe(false);
	if (!result.success)
		expect(result.error.issues.some((issue) => issue.path.join(".") === "memory_stores.notes.entries_mode")).toBe(true);
});

test.each(supportedModes)("$label mode initializes every seed when a new store is created", async ({ entriesMode }) => {
	const requests: { url: string; method: string; body: Record<string, unknown> }[] = [];
	globalThis.fetch = async (input, init) => {
		const request = new Request(input, init);
		const body = (await request.json()) as Record<string, unknown>;
		requests.push({ url: request.url, method: request.method, body });
		if (requests.length === 1)
			return Response.json({
				id: "memstore_created",
				type: "memory_store",
				name: "notes",
				description: "Project notes",
				metadata: { owner: "test" },
			});
		return Response.json({
			id: `memory_seed_${requests.length - 1}`,
			type: "memory",
			memory_store_id: "memstore_created",
			path: body.path,
			content: body.content,
			content_size_bytes: Buffer.byteLength(String(body.content)),
			content_sha256: "seed-content-hash",
			metadata: {},
			created_at: "2026-10-13T00:00:00Z",
			updated_at: "2026-10-13T00:00:00Z",
		});
	};
	const config = projectConfigSchema.parse(memoryProject(entriesMode));
	const declaration = config.memory_stores!.notes!;
	const created = await new ArkAdapter("test-key").createMemoryStore("notes", declaration);

	expect(created.id).toBe("memstore_created");
	expect(requests).toHaveLength(3);
	expect(requests.every((request) => request.method === "POST")).toBe(true);
	expect(requests[0]?.url).toEndWith("/memory_stores");
	expect(requests[0]?.body).toEqual({
		name: "notes",
		description: "Project notes",
		metadata: { owner: "test" },
	});
	expect(requests.slice(1).map((request) => request.url)).toEqual([
		`${requests[0]?.url}/memstore_created/memories`,
		`${requests[0]?.url}/memstore_created/memories`,
	]);
	expect(requests.slice(1).map((request) => request.body)).toEqual(
		entries.map((entry) => ({ path: `/${entry.key}`, content: entry.content })),
	);
});
