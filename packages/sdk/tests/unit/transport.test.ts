import { afterEach, expect, test } from "bun:test";
import { BaseApiClient } from "../../src/internal/providers/base-client.ts";
import { type FetchLike, resolveFetch, setDefaultFetch } from "../../src/internal/transport.ts";

class TestClient extends BaseApiClient {
	protected baseUrl = "https://example.test";
	protected errorPrefix = "test";
	protected paginationStrategy = "page" as const;

	protected headers(): Record<string, string> {
		return { "Content-Type": "application/json", Authorization: "Bearer k" };
	}
}

afterEach(() => {
	setDefaultFetch(undefined);
});

test("resolveFetch falls back to the current globalThis.fetch when nothing is installed", async () => {
	const originalFetch = globalThis.fetch;
	globalThis.fetch = (async () =>
		new Response(JSON.stringify({ id: "from-global" }), {
			status: 200,
		})) as unknown as typeof fetch;

	try {
		const res = await new TestClient().get("/x");
		expect(res).toEqual({ id: "from-global" });
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("setDefaultFetch routes provider client requests through the installed implementation", async () => {
	const captured: Array<{
		url: string;
		method?: string;
		headers: Record<string, string>;
	}> = [];
	const installed: FetchLike = async (input, init) => {
		captured.push({
			url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
			method: init?.method,
			headers: (init?.headers ?? {}) as Record<string, string>,
		});
		return new Response(JSON.stringify({ id: "from-installed" }), {
			status: 200,
		});
	};
	setDefaultFetch(installed);

	const res = await new TestClient().post("/agents", { name: "a" });
	expect(res).toEqual({ id: "from-installed" });
	expect(captured).toEqual([
		{
			url: "https://example.test/agents",
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer k",
			},
		},
	]);
});

test("installed implementation still gets ApiError semantics from the client (non-ok response)", async () => {
	setDefaultFetch(async () => new Response("missing", { status: 404 }));

	const err = (await new TestClient().get("/missing").catch((error: unknown) => error)) as Error & {
		statusCode?: number;
	};
	expect(err.statusCode).toBe(404);
});

test("setDefaultFetch(undefined) resets back to the global fetch", async () => {
	setDefaultFetch(async () => new Response("{}", { status: 200 }));
	setDefaultFetch(undefined);

	const originalFetch = globalThis.fetch;
	let globalHit = false;
	globalThis.fetch = (async () => {
		globalHit = true;
		return new Response("{}", { status: 200 });
	}) as unknown as typeof fetch;

	try {
		await resolveFetch()("https://example.test/ping");
		expect(globalHit).toBe(true);
	} finally {
		globalThis.fetch = originalFetch;
	}
});
