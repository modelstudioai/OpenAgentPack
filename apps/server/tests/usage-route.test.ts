import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setDefaultFetch } from "@openagentpack/sdk";
import { initializeDirectoryProject } from "@openagentpack/sdk/project-workspace";
import { app } from "@/app";
import { ProjectRuntimeManager, projectRuntimeManager } from "@/services/project-manager";

const environmentKeys = [
	"DASHSCOPE_API_KEY",
	"BAILIAN_API_KEY",
	"BAILIAN_BASE_URL",
	"BAILIAN_WORKSPACE_ID",
	"AGENTS_PROVIDER",
	"AGENTS_PLAYGROUND_TOKEN",
] as const;
let originalEnvironment: Map<string, string | undefined>;
let directory: string;
let manager: ProjectRuntimeManager;
const spies: Array<{ mockRestore(): void }> = [];
const summaryResponse = {
	request_id: "req_test",
	data: { data_updated_at: null, usage: { total: {}, models: [], tools: [] } },
};

beforeEach(async () => {
	originalEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]));
	for (const key of environmentKeys) delete process.env[key];
	directory = await mkdtemp(join(tmpdir(), "openagentpack-usage-route-"));
	await initializeDirectoryProject({ projectRoot: directory });
	await writeFile(
		join(directory, ".env"),
		"DASHSCOPE_API_KEY=project-test-key\nBAILIAN_BASE_URL=https://project-provider.test/api/v1/agentstudio\n",
	);
	manager = new ProjectRuntimeManager(directory);
	await manager.ensureStarted();
	expect(manager.getSnapshot().status).toBe("valid");
	spies.push(
		spyOn(projectRuntimeManager, "ensureStarted").mockImplementation(() => manager.ensureStarted()),
		spyOn(projectRuntimeManager, "requireRuntimeInput").mockImplementation(() => manager.requireRuntimeInput()),
	);
});

afterEach(async () => {
	for (const spy of spies.splice(0)) spy.mockRestore();
	manager?.close();
	setDefaultFetch(undefined);
	for (const [key, value] of originalEnvironment) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	if (directory) await rm(directory, { recursive: true, force: true });
});

function usageRequest() {
	return app.request("/api/usage/summary", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ dimension: "session", session_id: "test-session" }),
	});
}

describe("Workbench usage Provider selection", () => {
	test("uses project-local credentials when process credentials are absent", async () => {
		const calls: Array<{ url: string; authorization: string | null }> = [];
		setDefaultFetch(async (input, init) => {
			calls.push({
				url: input instanceof Request ? input.url : input.toString(),
				authorization: new Headers(init?.headers).get("Authorization"),
			});
			return Response.json(summaryResponse);
		});

		const response = await usageRequest();

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(summaryResponse);
		expect(calls).toEqual([
			{
				url: "https://project-provider.test/api/v1/agentstudio/usage/summary",
				authorization: "Bearer project-test-key",
			},
		]);
	});

	test("uses project-local credentials when process credentials are different", async () => {
		process.env.DASHSCOPE_API_KEY = "environment-test-key";
		process.env.BAILIAN_BASE_URL = "https://environment-provider.test/api/v1/agentstudio";
		process.env.AGENTS_PROVIDER = "claude";
		const calls: Array<{ url: string; authorization: string | null }> = [];
		setDefaultFetch(async (input, init) => {
			calls.push({
				url: input instanceof Request ? input.url : input.toString(),
				authorization: new Headers(init?.headers).get("Authorization"),
			});
			return Response.json(summaryResponse);
		});

		const response = await usageRequest();

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(summaryResponse);
		expect(calls).toEqual([
			{
				url: "https://project-provider.test/api/v1/agentstudio/usage/summary",
				authorization: "Bearer project-test-key",
			},
		]);
	});

	test("rejects a missing project instead of querying with process credentials", async () => {
		await rm(join(directory, "project.json"));
		await manager.refreshAfterSourceMutation();
		expect(manager.getSnapshot().status).toBe("missing");
		process.env.DASHSCOPE_API_KEY = "environment-test-key";
		process.env.BAILIAN_BASE_URL = "https://environment-provider.test/api/v1/agentstudio";
		let requests = 0;
		setDefaultFetch(async () => {
			requests += 1;
			return Response.json(summaryResponse);
		});

		const response = await usageRequest();

		expect(response.status).toBe(422);
		expect(await response.json()).toMatchObject({ error: { message: expect.stringContaining("missing") } });
		expect(requests).toBe(0);
	});
});

const validTimeRange = { start_time: "2026-11-02T10:00:00+08:00", end_time: "2026-11-02T15:00:00+08:00" };

function postSummary(body: unknown) {
	return app.request("/api/usage/summary", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

function countingFetch(): { requests: () => number } {
	let requests = 0;
	setDefaultFetch(async () => {
		requests += 1;
		return Response.json(summaryResponse);
	});
	return { requests: () => requests };
}

describe("Workbench usage upstream error mapping", () => {
	test("maps a Bailian 404 not_found to HTTP 404 instead of 500", async () => {
		setDefaultFetch(async () =>
			Response.json({ error: { code: "not_found", message: "Session not found." } }, { status: 404 }),
		);

		const response = await postSummary({ dimension: "session", session_id: "sesn_missing" });

		expect(response.status).toBe(404);
		const body = (await response.json()) as { error: { message: string } };
		expect(body.error.message).toContain("404");
	});

	test("maps a Bailian 400 query_limit_exceeded to HTTP 400 instead of 500", async () => {
		setDefaultFetch(async () =>
			Response.json({ error: { code: "query_limit_exceeded", message: "Narrow the time range." } }, { status: 400 }),
		);

		const response = await postSummary({ dimension: "workspace", time_range: validTimeRange });

		expect(response.status).toBe(400);
		const body = (await response.json()) as { error: { message: string } };
		expect(body.error.message).toContain("query_limit_exceeded");
	});

	test("returns 500 for a Bailian success response missing data", async () => {
		setDefaultFetch(async () => Response.json({ request_id: "req_missing" }));

		const response = await postSummary({ dimension: "workspace", time_range: validTimeRange });

		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({ error: { message: "Usage summary response is missing `data`." } });
	});
});

describe("Workbench usage request validation", () => {
	test("rejects a blank session_id with 400 before any upstream call", async () => {
		const fetch = countingFetch();

		const response = await postSummary({ dimension: "session", session_id: " " });

		expect(response.status).toBe(400);
		expect(fetch.requests()).toBe(0);
	});

	test("rejects fractional-second timestamps with 400 before any upstream call", async () => {
		const fetch = countingFetch();

		const response = await postSummary({
			dimension: "workspace",
			time_range: { start_time: "2026-11-02T10:00:00.500+08:00", end_time: validTimeRange.end_time },
		});

		expect(response.status).toBe(400);
		expect(fetch.requests()).toBe(0);
	});

	test("rejects hour 24 with 400 before any upstream call", async () => {
		const fetch = countingFetch();

		const response = await postSummary({
			dimension: "workspace",
			time_range: { ...validTimeRange, start_time: "2026-11-01T24:00:00+08:00" },
		});

		expect(response.status).toBe(400);
		expect(fetch.requests()).toBe(0);
	});

	test("rejects agent_id on the workspace dimension with 400 before any upstream call", async () => {
		const fetch = countingFetch();

		const response = await postSummary({ dimension: "workspace", time_range: validTimeRange, agent_id: "agent_one" });

		expect(response.status).toBe(400);
		expect(fetch.requests()).toBe(0);
	});

	test("rejects agent_version on the session dimension with 400 before any upstream call", async () => {
		const fetch = countingFetch();

		const response = await postSummary({ dimension: "session", session_id: "sesn_one", agent_version: "3" });

		expect(response.status).toBe(400);
		expect(fetch.requests()).toBe(0);
	});

	test("rejects a reversed window with 400 before any upstream call", async () => {
		const fetch = countingFetch();

		const response = await postSummary({
			dimension: "workspace",
			time_range: { start_time: validTimeRange.end_time, end_time: validTimeRange.start_time },
		});

		expect(response.status).toBe(400);
		expect(fetch.requests()).toBe(0);
	});

	test("rejects impossible calendar dates with 400 before any upstream call", async () => {
		const fetch = countingFetch();

		const response = await postSummary({
			dimension: "workspace",
			time_range: { start_time: "2026-02-30T10:00:00+08:00", end_time: "2026-03-01T10:00:00+08:00" },
		});

		expect(response.status).toBe(400);
		expect(fetch.requests()).toBe(0);
	});
});
