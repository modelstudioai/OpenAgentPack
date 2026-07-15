import { afterEach, describe, expect, test } from "bun:test";
import { createSessionFromPrompt } from "../src/lib/domain/session-api";

// The REST transport calls the global fetch directly, so tests mock globalThis.fetch
// and restore it afterward.
const originalFetch = globalThis.fetch;

// createSessionFromPrompt resolves the two managed base resources — the sandbox environment
// (GET /api/environments) and the credential vault (GET /api/vaults) — before POSTing the
// session, so the mock must answer all three routes. Both ids are then bound explicitly on the
// create body (environmentId + vaultIds).
const baseEnvironment = {
	id: "env_base",
	name: "Agents/base",
	metadata: { "agents.base": "true" },
};
const baseVault = {
	id: "vault_base",
	display_name: "Agents/secrets",
	metadata: { "agents.vault": "true" },
};

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("session API client", () => {
	test("submits agent id with resolved environment and vault ids", async () => {
		const requests: unknown[] = [];
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.includes("/api/environments")) return Response.json({ environments: [baseEnvironment] });
			if (url.includes("/api/vaults")) return Response.json({ vaults: [baseVault] });
			requests.push(JSON.parse(String(init?.body)));
			return Response.json({ session: { session_id: "session-1" }, events: [] });
		}) as typeof fetch;

		await createSessionFromPrompt("hello", "bailian-cli");

		expect(requests).toEqual([
			{ agentId: "bailian-cli", prompt: "hello", environmentId: "env_base", vaultIds: ["vault_base"] },
		]);
	});

	test("carries the selected model into create session", async () => {
		const requests: unknown[] = [];
		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.includes("/api/environments")) return Response.json({ environments: [baseEnvironment] });
			if (url.includes("/api/vaults")) return Response.json({ vaults: [baseVault] });
			requests.push(JSON.parse(String(init?.body)));
			return Response.json({ session: { session_id: "session-1" }, events: [] });
		}) as typeof fetch;

		await createSessionFromPrompt("hello", "bailian-cli", { model: "glm-5.1" });

		expect(requests).toEqual([
			{
				agentId: "bailian-cli",
				prompt: "hello",
				environmentId: "env_base",
				vaultIds: ["vault_base"],
				model: "glm-5.1",
			},
		]);
	});

	test("throws when no base environment exists", async () => {
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes("/api/environments")) return Response.json({ environments: [] });
			if (url.includes("/api/vaults")) return Response.json({ vaults: [baseVault] });
			return Response.json({ session: { session_id: "session-1" }, events: [] });
		}) as typeof fetch;

		await expect(createSessionFromPrompt("hello", "bailian-cli")).rejects.toThrow(/未检测到运行环境/);
	});

	test("throws when no base vault exists", async () => {
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes("/api/environments")) return Response.json({ environments: [baseEnvironment] });
			if (url.includes("/api/vaults")) return Response.json({ vaults: [] });
			return Response.json({ session: { session_id: "session-1" }, events: [] });
		}) as typeof fetch;

		await expect(createSessionFromPrompt("hello", "bailian-cli")).rejects.toThrow(/未检测到密钥库/);
	});

	test("surfaces API error message on failed create", async () => {
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url.includes("/api/environments")) return Response.json({ environments: [baseEnvironment] });
			if (url.includes("/api/vaults")) return Response.json({ vaults: [baseVault] });
			return Response.json({ error: { message: "agentId and prompt are required" } }, { status: 400 });
		}) as typeof fetch;

		await expect(createSessionFromPrompt(" ", "bailian-cli")).rejects.toThrow("agentId and prompt are required");
	});
});
