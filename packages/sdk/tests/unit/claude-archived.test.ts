import { describe, expect, test } from "bun:test";
import { ClaudeAdapter } from "../../src/internal/providers/claude/adapter.ts";

// Claude soft-deletes agents via POST /agents/{id}/archive; the object keeps
// showing up in GETs with archived_at set. findResource must treat archived
// resources as gone, or refresh plans updates against ghosts instead of
// recreating them.
describe("Claude archived resources are treated as gone", () => {
	function adapterWith(getImpl: (path: string) => Promise<unknown>, paged: Record<string, unknown>[] = []) {
		const adapter = new ClaudeAdapter("sk-test", undefined, "tmp") as any;
		adapter.client = { get: getImpl, getAllPaged: async () => paged };
		return adapter;
	}

	test("findResource returns null for an archived agent looked up by id", async () => {
		const adapter = adapterWith(async () => ({
			id: "agent_1",
			name: "a",
			archived_at: "2026-07-19T00:00:00Z",
		}));
		expect(await adapter.findResource("agent", "a", "agent_1")).toBeNull();
	});

	test("findResource returns active resources", async () => {
		const adapter = adapterWith(async () => ({ id: "agent_1", name: "a", archived_at: null }));
		expect((await adapter.findResource("agent", "a", "agent_1"))?.id).toBe("agent_1");
	});

	test("name scan skips archived entries and matches active ones", async () => {
		const adapter = adapterWith(async () => {
			throw new Error("id path must not be used");
		}, [
			{ id: "agent_archived", name: "a", archived_at: "2026-07-19T00:00:00Z" },
			{ id: "agent_active", name: "a" },
		]);
		expect((await adapter.findResource("agent", "a"))?.id).toBe("agent_active");
	});
});
