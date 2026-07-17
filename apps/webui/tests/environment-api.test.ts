import { afterEach, describe, expect, test } from "bun:test";
import { createApiEnvironment } from "../src/lib/api/client";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("environment API adapter", () => {
	test("unwraps the generated wire response for domain callers", async () => {
		globalThis.fetch = (async () =>
			Response.json({ environment: { id: "env_1", type: "cloud", version: 2 } })) as typeof fetch;

		const result = await createApiEnvironment({ body: { name: "Agents/base" } });

		expect(result).toEqual({ data: { id: "env_1", type: "cloud", version: 2 } });
	});
});
