import { expect, test } from "bun:test";
import { ApiError, BaseApiClient, ConflictError } from "../../src/internal/providers/base-client.ts";

class TestClient extends BaseApiClient {
	protected baseUrl = "https://example.test";
	protected errorPrefix = "test";
	protected paginationStrategy = "page" as const;

	protected headers(): Record<string, string> {
		return {};
	}
}

function sseResponse(text: string): Response {
	return new Response(
		new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(text));
				controller.close();
			},
		}),
	);
}

test("BaseApiClient.sse skips complete heartbeat frames", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () =>
		sseResponse(
			": heartbeat\n" + "event: heartbeat\n" + "data: {}\n\n" + 'data: {"type":"message","content":"ok"}\n\n',
		)) as unknown as typeof fetch;

	try {
		const events: Record<string, unknown>[] = [];
		for await (const event of new TestClient().sse("/events")) {
			events.push(event);
		}

		expect(events).toEqual([{ type: "message", content: "ok" }]);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("BaseApiClient.postFormData drops Content-Type and sends remaining headers", async () => {
	const originalFetch = globalThis.fetch;
	let captured: { url: string; method?: string; headers: Record<string, string>; body: unknown } | undefined;

	class FormClient extends BaseApiClient {
		protected baseUrl = "https://example.test";
		protected errorPrefix = "test";
		protected paginationStrategy = "page" as const;
		protected headers(): Record<string, string> {
			return { "Content-Type": "application/json", Authorization: "Bearer k" };
		}
	}

	globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
		captured = {
			url: typeof input === "string" ? input : input.toString(),
			method: init?.method,
			headers: (init?.headers ?? {}) as Record<string, string>,
			body: init?.body,
		};
		return new Response(JSON.stringify({ id: "f1" }), { status: 200 });
	}) as unknown as typeof fetch;

	try {
		const fd = new FormData();
		fd.append("file", new File([new Uint8Array([1, 2, 3])], "a.bin"));
		const res = await new FormClient().postFormData("/files", fd);

		expect(res).toEqual({ id: "f1" });
		expect(captured?.url).toBe("https://example.test/files");
		expect(captured?.method).toBe("POST");
		expect(captured?.headers).toEqual({ Authorization: "Bearer k" });
		expect(captured?.body).toBeInstanceOf(FormData);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

function makePagedClient(strategy: "page" | "after_id", calls: string[]) {
	class PagedClient extends BaseApiClient {
		protected baseUrl = "https://example.test";
		protected errorPrefix = "test";
		protected paginationStrategy = strategy;
		protected headers(): Record<string, string> {
			return {};
		}
	}
	return { client: new PagedClient(), calls };
}

test("getAllPaged walks every page using the page cursor", async () => {
	const originalFetch = globalThis.fetch;
	const calls: string[] = [];
	const pages = [
		{ data: [{ id: "a1" }], next_page: "TOK2" },
		{ data: [{ id: "a2" }], next_page: null },
	];
	let i = 0;
	globalThis.fetch = (async (input: string | URL) => {
		calls.push(typeof input === "string" ? input : input.toString());
		return new Response(JSON.stringify(pages[i++]), { status: 200 });
	}) as unknown as typeof fetch;

	try {
		const { client } = makePagedClient("page", calls);
		const all = await client.getAllPaged("/agents");
		expect(all.map((r) => r.id)).toEqual(["a1", "a2"]);
		expect(calls).toEqual(["https://example.test/agents?limit=100", "https://example.test/agents?limit=100&page=TOK2"]);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("getAllPaged walks every page using the after_id cursor and stops on has_more=false", async () => {
	const originalFetch = globalThis.fetch;
	const calls: string[] = [];
	const pages = [
		{ data: [{ id: "a1" }], has_more: true, last_id: "a1" },
		{ data: [{ id: "a2" }], has_more: false, last_id: "a2" },
	];
	let i = 0;
	globalThis.fetch = (async (input: string | URL) => {
		calls.push(typeof input === "string" ? input : input.toString());
		return new Response(JSON.stringify(pages[i++]), { status: 200 });
	}) as unknown as typeof fetch;

	try {
		const { client } = makePagedClient("after_id", calls);
		const all = await client.getAllPaged("/agents");
		expect(all.map((r) => r.id)).toEqual(["a1", "a2"]);
		expect(calls).toEqual([
			"https://example.test/agents?limit=100",
			"https://example.test/agents?limit=100&after_id=a1",
		]);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("getAllPaged appends with & when the path already has a query string", async () => {
	const originalFetch = globalThis.fetch;
	const calls: string[] = [];
	globalThis.fetch = (async (input: string | URL) => {
		calls.push(typeof input === "string" ? input : input.toString());
		return new Response(JSON.stringify({ data: [], next_page: null }), { status: 200 });
	}) as unknown as typeof fetch;

	try {
		const { client } = makePagedClient("page", calls);
		await client.getAllPaged("/agents?source=official");
		expect(calls).toEqual(["https://example.test/agents?source=official&limit=100"]);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("getAllPaged stops on an empty data page even if a cursor is present", async () => {
	const originalFetch = globalThis.fetch;
	let i = 0;
	const pages = [{ data: [], next_page: "TOK2" }];
	globalThis.fetch = (async () => new Response(JSON.stringify(pages[i++]), { status: 200 })) as unknown as typeof fetch;

	try {
		const { client } = makePagedClient("page", []);
		const all = await client.getAllPaged("/agents");
		expect(all).toEqual([]);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("throwIfError does not throw when res.ok", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;

	try {
		await new TestClient().get("/ok");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("throwIfError throws ConflictError when isConflict returns true", async () => {
	class ConflictClient extends TestClient {
		protected override isConflict(_status: number, _body: string): boolean {
			return true;
		}
	}

	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () => new Response("already exists", { status: 409 })) as unknown as typeof fetch;

	try {
		await expect(new ConflictClient().post("/x", {})).rejects.toBeInstanceOf(ConflictError);
		const err = await new ConflictClient().post("/x", {}).catch((e) => e);
		expect(err).toBeInstanceOf(ConflictError);
		expect(err).toBeInstanceOf(ApiError);
		expect(err.statusCode).toBe(409);
		expect(err.responseBody).toBe("already exists");
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("throwIfError throws plain ApiError when isConflict returns false, and ApiError.isNotFound classifies 404", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () => new Response("missing", { status: 404 })) as unknown as typeof fetch;

	try {
		const err = await new TestClient().get("/missing").catch((e) => e);
		expect(err).toBeInstanceOf(ApiError);
		expect(err).not.toBeInstanceOf(ConflictError);
		expect(ApiError.isNotFound(err)).toBe(true);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("ApiError.isNotFound returns false for non-ApiError, 409, and ConflictError", () => {
	expect(ApiError.isNotFound(new Error("plain"))).toBe(false);
	expect(ApiError.isNotFound(null)).toBe(false);
	expect(ApiError.isNotFound(new ApiError(409, "conflict", "p"))).toBe(false);
	expect(ApiError.isNotFound(new ConflictError(409, "conflict", "p"))).toBe(false);
});
