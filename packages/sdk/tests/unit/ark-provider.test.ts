import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshState } from "../../src/internal/planner/refresh.ts";
import { ArkAdapter } from "../../src/internal/providers/ark/adapter.ts";
import { mapAgent } from "../../src/internal/providers/ark/mapper.ts";
import { StateManager } from "../../src/internal/state/state-manager.ts";

function tmpPath(): string {
	return join(tmpdir(), `ark-provider-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("Ark provider platform gaps", () => {
	test("keeps emulated deployment state during refresh", async () => {
		const adapter = new ArkAdapter("ak-test-dummy");
		const state = StateManager.initialize(tmpPath());
		const address = { type: "deployment" as const, name: "daily", provider: "ark" };

		state.setResource({
			address,
			remote_id: null,
			content_hash: "h",
		});

		const result = await refreshState(state, new Map([["ark", adapter]]), {
			targetProviders: ["ark"],
			quiet: true,
		});

		expect(result.removed).toEqual([]);
		expect(state.getResource(address)).toBeDefined();
		expect(state.getResource(address)?.drift_status).toBe("unchecked");
	});

	test("skips skill export because Ark has no skill list endpoint", async () => {
		const urls: string[] = [];
		globalThis.fetch = (async (url) => {
			urls.push(String(url));
			return new Response("not found", { status: 404 });
		}) as typeof fetch;

		const adapter = new ArkAdapter("ak-test-dummy");
		await expect(adapter.exportResources("skill")).resolves.toEqual([]);
		expect(urls).toEqual([]);
	});

	test("createEnvironment retries with suffixed wire name when Ark returns 409 name conflict", async () => {
		const postedBodies: string[] = [];
		let createCalls = 0;
		globalThis.fetch = (async (_url, init) => {
			const body = String(init?.body ?? "");
			postedBodies.push(body);
			createCalls += 1;
			if (createCalls === 1) {
				return new Response(
					JSON.stringify({
						error: {
							code: "ResourceConflict",
							message: 'name: "agents-base" already exists in project "default"',
						},
					}),
					{ status: 409 },
				);
			}
			return new Response(JSON.stringify({ id: "env-retry-ok", type: "environment" }), { status: 200 });
		}) as typeof fetch;

		const adapter = new ArkAdapter("ak-test-dummy");
		const result = await adapter.createEnvironment("Agents/base", {
			config: { type: "cloud", networking: { type: "unrestricted" } },
		});

		expect(result.id).toBe("env-retry-ok");
		expect(createCalls).toBe(2);
		expect(JSON.parse(postedBodies[0]!).name).toBe("agents-base");
		expect(JSON.parse(postedBodies[1]!).name).toBe("agents-base-1");
	});
});

describe("Ark mapAgent multiagent regression", () => {
	test("maps a resolved roster to AgentRef objects", () => {
		const body = mapAgent(
			"lead",
			{
				model: { ark: "doubao-seed-1-6" },
				instructions: "Help.",
				multiagent: { type: "coordinator", agents: ["reviewer", "writer"] },
			},
			{
				skill_ids: [],
				multiagent: {
					type: "coordinator",
					members: [
						{ logical_name: "reviewer", resource_type: "agent", remote_id: "agent_reviewer_1" },
						{ logical_name: "writer", resource_type: "agent", remote_id: "agent_writer_1" },
					],
				},
			},
		) as Record<string, unknown>;
		expect(body.multiagent).toEqual({
			type: "coordinator",
			agents: [
				{ type: "agent", id: "agent_reviewer_1" },
				{ type: "agent", id: "agent_writer_1" },
			],
		});
	});
});
