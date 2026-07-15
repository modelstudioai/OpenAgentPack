import { describe, expect, test } from "bun:test";
import { BaseApiClient } from "../../src/internal/providers/base-client.ts";
import {
	buildSessionInfo,
	type ExportMappers,
	exportRemoteResources,
	locateRemote,
} from "../../src/internal/providers/shared.ts";

class StubClient extends BaseApiClient {
	protected baseUrl = "https://stub.test";
	protected errorPrefix = "stub";
	protected paginationStrategy = "page" as const;
	protected headers(): Record<string, string> {
		return {};
	}
	getResponses: Array<{ status: number; body?: unknown }> = [];
	pagedResult: Array<Record<string, unknown>> = [];
	getCalls: string[] = [];

	async get(path: string): Promise<unknown> {
		this.getCalls.push(path);
		const r = this.getResponses.shift();
		if (!r) throw new Error(`unexpected get ${path}`);
		if (r.status === 404) {
			const { ApiError } = await import("../../src/internal/providers/base-client.ts");
			throw new ApiError(404, "not found", this.errorPrefix);
		}
		if (r.status >= 400) {
			const { ApiError } = await import("../../src/internal/providers/base-client.ts");
			throw new ApiError(r.status, "err", this.errorPrefix);
		}
		return r.body;
	}
	async getAllPaged(): Promise<Array<Record<string, unknown>>> {
		return this.pagedResult;
	}
}

describe("locateRemote", () => {
	test("returns null when endpoint is undefined (unsupported type)", async () => {
		const c = new StubClient();
		expect(await locateRemote(c, undefined, "x", null)).toBeNull();
	});

	test("id path returns the raw object via detail GET", async () => {
		const c = new StubClient();
		c.getResponses = [{ status: 200, body: { id: "r1", name: "x" } }];
		const raw = await locateRemote(c, "/agents", "x", "r1");
		expect(raw).toEqual({ id: "r1", name: "x" });
		expect(c.getCalls).toEqual(["/agents/r1"]);
	});

	test("id path returns null on 404", async () => {
		const c = new StubClient();
		c.getResponses = [{ status: 404 }];
		expect(await locateRemote(c, "/agents", "x", "r1")).toBeNull();
	});

	test("id path rethrows non-404 errors", async () => {
		const c = new StubClient();
		c.getResponses = [{ status: 500 }];
		await expect(locateRemote(c, "/agents", "x", "r1")).rejects.toThrow(/500/);
	});

	test("name path scans pages and matches by name", async () => {
		const c = new StubClient();
		c.pagedResult = [
			{ id: "a", name: "other" },
			{ id: "b", name: "target" },
		];
		const raw = await locateRemote(c, "/agents", "target", null);
		expect(raw?.id).toBe("b");
	});

	test("accept predicate filters both id and name paths", async () => {
		const c1 = new StubClient();
		c1.getResponses = [{ status: 200, body: { id: "r1", name: "x", archived_at: "2026" } }];
		expect(await locateRemote(c1, "/agents", "x", "r1", (r) => !r.archived_at)).toBeNull();

		const c2 = new StubClient();
		c2.pagedResult = [
			{ id: "a", name: "target", archived_at: "2026" },
			{ id: "b", name: "target" },
		];
		const raw = await locateRemote(c2, "/agents", "target", null, (r) => !r.archived_at);
		expect(raw?.id).toBe("b");
	});
});

describe("buildSessionInfo", () => {
	const base = {
		id: "s1",
		agent: { id: "a1" },
		environment_id: "e1",
		status: "idle",
		created_at: "2026-01-01T00:00:00Z",
		updated_at: "2026-01-01T01:00:00Z",
	};

	test("claude-style picker reads memory_store from resources", () => {
		const info = buildSessionInfo(
			{
				...base,
				resources: [
					{ type: "memory_store", memory_store_id: "ms1" },
					{ type: "file", file_id: "f" },
				],
			},
			(r) =>
				((r.resources as Array<Record<string, unknown>>) ?? [])
					.filter((x) => x.type === "memory_store")
					.map((x) => x.memory_store_id as string),
		);
		expect(info.memory_store_ids).toEqual(["ms1"]);
		expect(info.agent_id).toBe("a1");
	});

	test("qoder-style picker reads memory_store_ids and flat agent_id fallback", () => {
		const info = buildSessionInfo(
			{ id: "s2", agent_id: "flat", environment_id: "e", status: "idle", memory_store_ids: ["ms2"] },
			(r) => (r.memory_store_ids as string[]) ?? [],
		);
		expect(info.memory_store_ids).toEqual(["ms2"]);
		expect(info.agent_id).toBe("flat");
	});

	test("bailian-style picker is always empty", () => {
		const info = buildSessionInfo(base, () => []);
		expect(info.memory_store_ids).toEqual([]);
	});
});

class ExportStub extends BaseApiClient {
	protected baseUrl = "https://stub.test";
	protected errorPrefix = "stub";
	protected paginationStrategy = "page" as const;
	protected headers(): Record<string, string> {
		return {};
	}
	pagedByPath: Record<string, Array<Record<string, unknown>>> = {};
	async getAllPaged(path: string): Promise<Array<Record<string, unknown>>> {
		return this.pagedByPath[path] ?? [];
	}
}

const idMappers: ExportMappers = {
	envToDecl: (r) => ({ kind: "env", id: r.id }),
	vaultToDecl: (r, creds, name) => ({ kind: "vault", id: r.id, creds: creds.length, name }),
	fileToDecl: (r, filename) => ({ kind: "file", id: r.file_id ?? r.id, filename }),
	skillToDecl: (r, name) => ({ kind: "skill", id: r.id, name }),
};

describe("exportRemoteResources", () => {
	test("file branch tolerates file_id (qoder) and id (claude/bailian)", async () => {
		const c = new ExportStub();
		c.pagedByPath = {
			"/files": [
				{ file_id: "fq", filename: "q.txt" },
				{ id: "fc", filename: "c.txt" },
			],
		};
		const out = await exportRemoteResources(c, "file", idMappers);
		expect(out.map((o) => (o.decl as { id: string }).id)).toEqual(["fq", "fc"]);
		// resourceNameFromMetadata slugifies the display label (no agents metadata present).
		expect(out.map((o) => o.name)).toEqual(["q-txt", "c-txt"]);
	});

	test("skill branch tolerates display_title (claude) and name (qoder/bailian)", async () => {
		const c = new ExportStub();
		c.pagedByPath = {
			"/skills": [
				{ id: "s1", display_title: "Title" },
				{ id: "s2", name: "named" },
			],
		};
		const out = await exportRemoteResources(c, "skill", idMappers);
		// display_title wins for s1, name for s2; both slugified by resourceNameFromMetadata.
		expect(out.map((o) => o.name)).toEqual(["title", "named"]);
	});

	test("vault branch fetches credentials per vault and tolerates display_name/name", async () => {
		const c = new ExportStub();
		c.pagedByPath = {
			"/vaults": [
				{ id: "v1", display_name: "Disp" },
				{ id: "v2", name: "Named" },
			],
			"/vaults/v1/credentials": [{ id: "c1" }],
			"/vaults/v2/credentials": [],
		};
		const out = await exportRemoteResources(c, "vault", idMappers);
		// display_name wins for v1, name for v2; both slugified by resourceNameFromMetadata.
		expect(out.map((o) => o.name)).toEqual(["disp", "named"]);
		expect((out[0]!.decl as { creds: number }).creds).toBe(1);
	});

	test("unsupported type returns empty", async () => {
		const c = new ExportStub();
		expect(await exportRemoteResources(c, "memory_store", idMappers)).toEqual([]);
	});
});
