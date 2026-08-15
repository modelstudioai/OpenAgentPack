import { afterEach, describe, expect, test } from "bun:test";
import { app } from "@/app";

const originalToken = process.env.AGENTS_PLAYGROUND_TOKEN;

afterEach(() => {
	if (originalToken === undefined) delete process.env.AGENTS_PLAYGROUND_TOKEN;
	else process.env.AGENTS_PLAYGROUND_TOKEN = originalToken;
});

describe("Playground local write protection", () => {
	test("requires the launch token for every mutating API request", async () => {
		process.env.AGENTS_PLAYGROUND_TOKEN = "test-local-token";
		const request = new Request("http://localhost/api/project/agents/assistant/plan", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ refresh: false }),
		});

		const denied = await app.request(request);
		expect(denied.status).toBe(403);
		expect(await denied.json()).toEqual({ error: { message: "Invalid Playground access token." } });

		const authenticated = await app.request("/api/project/agents/assistant/plan", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Agents-Playground-Token": "test-local-token",
			},
			body: JSON.stringify({ refresh: false }),
		});
		expect(authenticated.status).not.toBe(403);
	});

	test("does not grant CORS access to an unrelated origin", async () => {
		const response = await app.request("/health", { headers: { Origin: "https://example.invalid" } });
		expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
	});
});
