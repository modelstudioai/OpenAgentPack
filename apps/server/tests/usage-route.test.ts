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
const page = { items: [], total: 0, total_call_count: 0, page_no: 1, page_size: 20, data_updated_at: 0 };

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

function usageRequest(path: string) {
	return app.request(path, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ scope: { type: "session", session_id: "test-session" } }),
	});
}

describe("Workbench usage Provider selection", () => {
	for (const [resource, processCredentials] of [
		["models", false],
		["tools", true],
	] as const) {
		test(`${resource} uses project-local credentials when process credentials are ${processCredentials ? "different" : "absent"}`, async () => {
			if (processCredentials) {
				process.env.DASHSCOPE_API_KEY = "environment-test-key";
				process.env.BAILIAN_BASE_URL = "https://environment-provider.test/api/v1/agentstudio";
				process.env.AGENTS_PROVIDER = "claude";
			}
			const calls: Array<{ url: string; authorization: string | null }> = [];
			setDefaultFetch(async (input, init) => {
				calls.push({
					url: input instanceof Request ? input.url : input.toString(),
					authorization: new Headers(init?.headers).get("Authorization"),
				});
				return Response.json({ data: page });
			});

			const response = await usageRequest(`/api/usage/${resource}`);

			expect(response.status).toBe(200);
			expect(await response.json()).toEqual(page);
			expect(calls).toEqual([
				{
					url: `https://project-provider.test/api/v1/agentstudio/usage/${resource}`,
					authorization: "Bearer project-test-key",
				},
			]);
		});
	}

	test("rejects a missing project instead of querying with process credentials", async () => {
		await rm(join(directory, "project.json"));
		await manager.refreshAfterSourceMutation();
		expect(manager.getSnapshot().status).toBe("missing");
		process.env.DASHSCOPE_API_KEY = "environment-test-key";
		process.env.BAILIAN_BASE_URL = "https://environment-provider.test/api/v1/agentstudio";
		let requests = 0;
		setDefaultFetch(async () => {
			requests += 1;
			return Response.json({ data: page });
		});

		const response = await usageRequest("/api/usage/models");

		expect(response.status).toBe(422);
		expect(await response.json()).toMatchObject({ error: { message: expect.stringContaining("missing") } });
		expect(requests).toBe(0);
	});
});
