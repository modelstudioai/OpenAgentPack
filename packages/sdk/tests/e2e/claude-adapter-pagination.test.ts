import { afterEach, describe, expect, mock, test } from "bun:test";
import { ClaudeAdapter } from "../../src/internal/providers/claude/adapter.ts";

// The managed-agents beta paginates with an opaque `next_page` cursor passed
// back as `?page=<token>` — NOT the `after_id`/`has_more` scheme. These tests
// lock in that list endpoints walk every page (so findResource never misses a
// resource past the first 100 and creates a duplicate) and that session-event
// pagination forwards `page` + echoes `next_page` for the cross-provider loop.

interface CapturedCall {
	url: string;
	method: string;
}

const BASE = "https://api.anthropic.com/v1";

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

function makeAdapter(): ClaudeAdapter {
	return new ClaudeAdapter("sk-ant-test", undefined, "test-project");
}

describe("ClaudeAdapter pagination (next_page cursor)", () => {
	let cleanup: (() => void) | undefined;

	afterEach(() => {
		cleanup?.();
		cleanup = undefined;
	});

	test("findResource follows next_page (via ?page=) to a name on a later page", async () => {
		const { calls, restore } = mockFetch([
			// /agents omits has_more entirely — only next_page signals more pages.
			{ status: 200, body: { data: [{ id: "agent_1", name: "other", type: "agent" }], next_page: "page_TOK2" } },
			{ status: 200, body: { data: [{ id: "agent_t", name: "target", type: "agent" }], next_page: null } },
		]);
		cleanup = restore;

		const result = await makeAdapter().findResource("agent", "target");

		expect(calls.map((c) => c.url)).toEqual([`${BASE}/agents?limit=100`, `${BASE}/agents?limit=100&page=page_TOK2`]);
		expect(result!.id).toBe("agent_t");
	});

	test("listSessionEvents forwards page and echoes next_page", async () => {
		const { calls, restore } = mockFetch([
			{ status: 200, body: { data: [{ id: "sevt_2", type: "message" }], next_page: "page_TOK3" } },
		]);
		cleanup = restore;

		const res = await makeAdapter().listSessionEvents("sesn_1", { limit: 200, page: "page_TOK2" });

		expect(calls[0].url).toBe(`${BASE}/sessions/sesn_1/events?limit=200&page=page_TOK2`);
		expect(res.has_more).toBe(true);
		expect(res.next_page).toBe("page_TOK3");
	});

	test("listSessionEvents never forwards after_id (rejected with 400 by the API)", async () => {
		const { calls, restore } = mockFetch([{ status: 200, body: { data: [], next_page: null } }]);
		cleanup = restore;

		const res = await makeAdapter().listSessionEvents("sesn_1", { after_id: "sevt_x" });

		expect(calls[0].url).toBe(`${BASE}/sessions/sesn_1/events`);
		expect(res.has_more).toBe(false);
		expect(res.next_page).toBeUndefined();
	});
});
