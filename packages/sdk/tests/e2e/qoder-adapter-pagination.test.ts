import { afterEach, describe, expect, mock, test } from "bun:test";
import { QoderAdapter, toSessionInfo } from "../../src/internal/providers/qoder/adapter.ts";

// Qoder paginates with an `after_id` cursor (server echoes `has_more` + `last_id`).
// These tests lock in that name lookups and the cascade-delete session scan walk
// every page, so resources/sessions past the first 100 are never missed.

interface CapturedCall {
	url: string;
	method: string;
}

const BASE = "https://api.qoder.com/api/v1/cloud";

function mockFetch(responses: Array<{ status: number; body?: unknown }>) {
	let callIndex = 0;
	const calls: CapturedCall[] = [];
	const originalFetch = globalThis.fetch;

	globalThis.fetch = mock(async (input: string | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		const method = init?.method ?? "GET";
		calls.push({ url, method });

		const resp = responses[callIndex++];
		if (!resp) throw new Error(`Unexpected fetch call #${callIndex}: ${method} ${url}`);

		return new Response(resp.body !== undefined ? JSON.stringify(resp.body) : "", {
			status: resp.status,
			headers: { "Content-Type": "application/json" },
		});
	}) as unknown as typeof fetch;

	return {
		calls,
		restore: () => {
			globalThis.fetch = originalFetch;
		},
	};
}

function makeAdapter(): QoderAdapter {
	return new QoderAdapter("qdr-test-key", undefined, "test-project");
}

describe("QoderAdapter pagination regressions", () => {
	let cleanup: (() => void) | undefined;

	afterEach(() => {
		cleanup?.();
		cleanup = undefined;
	});

	test("findResource follows after_id pagination to a name on a later page", async () => {
		const { calls, restore } = mockFetch([
			{
				status: 200,
				body: { data: [{ id: "agent_1", name: "other", type: "agent" }], has_more: true, last_id: "agent_1" },
			},
			{
				status: 200,
				body: { data: [{ id: "agent_t", name: "target", type: "agent" }], has_more: false, last_id: "agent_t" },
			},
		]);
		cleanup = restore;

		const result = await makeAdapter().findResource("agent", "target");

		expect(calls.map((c) => c.url)).toEqual([`${BASE}/agents?limit=100`, `${BASE}/agents?limit=100&after_id=agent_1`]);
		expect(result!.id).toBe("agent_t");
	});

	test("deleteEnvironment cascade scans every session page before deleting", async () => {
		const ENV = "env_x";
		const { calls, restore } = mockFetch([
			// initial delete is rejected because the env is referenced
			{ status: 409, body: { error: "environment in use" } },
			// session page 1: one blocking session + a forward cursor
			{
				status: 200,
				body: { data: [{ id: "s1", environment_id: ENV, status: "idle" }], has_more: true, last_id: "s1" },
			},
			// session page 2: a second blocking session lives past page 1
			{
				status: 200,
				body: {
					data: [
						{ id: "s2", environment_id: ENV, status: "running" },
						{ id: "s3", environment_id: "env_other", status: "idle" },
					],
					has_more: false,
					last_id: "s3",
				},
			},
			{ status: 200 }, // delete s1
			{ status: 200 }, // delete s2
			{ status: 200 }, // delete env (retry, now unblocked)
		]);
		cleanup = restore;

		await makeAdapter().deleteEnvironment(ENV, true);

		expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
			`DELETE ${BASE}/environments/${ENV}`,
			`GET ${BASE}/sessions?limit=100`,
			`GET ${BASE}/sessions?limit=100&after_id=s1`,
			`DELETE ${BASE}/sessions/s1`,
			`DELETE ${BASE}/sessions/s2`,
			`DELETE ${BASE}/environments/${ENV}`,
		]);
	});

	test("deleteEnvironment without cascade lists all blocking sessions in the error", async () => {
		const ENV = "env_x";
		const { restore } = mockFetch([
			{ status: 409, body: { error: "environment in use" } },
			{
				status: 200,
				body: { data: [{ id: "s1", environment_id: ENV, status: "idle" }], has_more: true, last_id: "s1" },
			},
			{
				status: 200,
				body: { data: [{ id: "s2", environment_id: ENV, status: "running" }], has_more: false, last_id: "s2" },
			},
		]);
		cleanup = restore;

		// Both blocking sessions (across both pages) must surface in the error.
		await expect(makeAdapter().deleteEnvironment(ENV, false)).rejects.toThrow(/s1 \(idle\).*s2 \(running\)/);
	});
});

describe("QoderAdapter readComparableResource id-404 no-fallback", () => {
	let cleanup: (() => void) | undefined;

	afterEach(() => {
		cleanup?.();
		cleanup = undefined;
	});

	test("returns null on an id-path 404 without a name-scan list fallback", async () => {
		// locateRemote convergence (human-accepted): when an id is supplied and the
		// detail GET 404s, return null immediately — no fall-through to a paginated
		// name scan of the bare `/agents?limit=100` collection.
		const { calls, restore } = mockFetch([{ status: 404, body: { error: "not found" } }]);
		cleanup = restore;

		const result = await makeAdapter().readComparableResource("agent", "agent_missing", "target");

		expect(result).toBeNull();
		expect(calls.map((c) => c.url)).toContain(`${BASE}/agents/agent_missing`);
		expect(calls.map((c) => c.url)).not.toContain(`${BASE}/agents?limit=100`);
	});
});

describe("QoderAdapter toSessionInfo agent_id extraction", () => {
	// Real Qoder session responses (create/list/get) embed the agent as an
	// object under `agent` and carry no top-level `agent_id`. Reading
	// `res.agent_id` directly always yielded undefined.
	test("reads agent_id from the embedded agent object", () => {
		const info = toSessionInfo({
			id: "sess_1",
			agent: { id: "agent_real", name: "researcher" },
			environment_id: "env_1",
			status: "idle",
			vault_ids: [],
		});
		expect(info.agent_id).toBe("agent_real");
	});

	test("falls back to top-level agent_id when no agent object is present", () => {
		const info = toSessionInfo({ id: "sess_2", agent_id: "agent_flat", environment_id: "env_1", status: "idle" });
		expect(info.agent_id).toBe("agent_flat");
	});
});

describe("QoderAdapter listSessionEvents page cursor", () => {
	let cleanup: (() => void) | undefined;

	afterEach(() => {
		cleanup?.();
		cleanup = undefined;
	});

	test("forwards page and echoes next_page so the cross-provider loop advances", async () => {
		const { calls, restore } = mockFetch([
			{ status: 200, body: { data: [{ id: "evt_2", type: "message" }], has_more: true, next_page: "evt_2" } },
		]);
		cleanup = restore;

		const res = await makeAdapter().listSessionEvents("sess_1", { limit: 200, page: "evt_1" });

		expect(calls[0].url).toBe(`${BASE}/sessions/sess_1/events?limit=200&page=evt_1`);
		expect(res.has_more).toBe(true);
		expect(res.next_page).toBe("evt_2");
	});
});
