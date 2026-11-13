import { afterEach, expect, test } from "bun:test";
import {
	InMemoryStateManager,
	ResourceRuntimeError,
	resolveProjectConfigFromObject,
	type StateBackend,
	setDefaultFetch,
	syncProjectResourcesWithStateBackend,
} from "../../src/index.ts";

afterEach(() => setDefaultFetch(undefined));

// Protect the public plan/apply/persist workflow when the backend's final commit
// fails after its callback has already finished mutating the Provider.
test.each([
	{ resultDetail: "legacy", includeResource: true },
	{ resultDetail: "structured", includeResource: true },
	{ resultDetail: "structured", includeResource: false },
] as const)("$resultDetail preserves a final backend commit failure (remote write: $includeResource)", async ({
	resultDetail,
	includeResource,
}) => {
	const loaded = await resolveProjectConfigFromObject(
		{
			version: "1",
			providers: {
				bailian: { api_key: "fixture", base_url: "https://fixture.invalid/api/v1/agentstudio" },
			},
			defaults: { provider: "bailian" },
			environments: includeResource ? { dev: { config: { type: "cloud" } } } : {},
			agents: {},
		},
		{ projectName: "backend-contract", resolveEnv: false },
	);
	let created = false;
	setDefaultFetch(async (input, init) => {
		const request = new Request(input, init);
		const path = new URL(request.url).pathname;
		if (request.method === "POST" && path.endsWith("/environments")) {
			created = true;
			return Response.json({ id: "env_created", name: "dev", config: { type: "cloud" } });
		}
		if (request.method === "GET" && path.endsWith("/environments/env_created")) {
			return Response.json({ id: "env_created", name: "dev", config: { type: "cloud" } });
		}
		throw new Error(`Unexpected fixture request: ${request.method} ${path}`);
	});
	const commitFailure = new Error("backend commit unavailable");
	let commitAttempted = false;
	const state = InMemoryStateManager.empty();
	const stateBackend: StateBackend = {
		read: async (_scope, run) => run(state),
		write: async (_scope, run) => {
			await run(state);
			commitAttempted = true;
			throw commitFailure;
		},
	};
	const result = await syncProjectResourcesWithStateBackend(
		{
			projectName: "backend-contract",
			config: loaded.config,
			stateBackend,
			stateScope: { projectId: "backend-contract" },
		},
		{ refresh: false, resultDetail },
	).catch((error: unknown) => error);

	expect(created).toBe(includeResource);
	expect(commitAttempted).toBe(true);
	if (resultDetail === "legacy") {
		expect(result).toBe(commitFailure);
		return;
	}
	expect(result).toBeInstanceOf(ResourceRuntimeError);
	const failure = result as ResourceRuntimeError;
	expect(failure.cause).toBe(commitFailure);
	expect(failure.info).toMatchObject({
		code: "resource.state_persist_failed",
		phase: "persist_state",
		mutationStarted: includeResource,
	});
	expect(failure.execution).toMatchObject({
		outcome: includeResource ? "unknown" : "failed",
		mutationStarted: includeResource,
		partial: false,
		results: includeResource ? [{ status: "success", resource: { remoteId: "env_created" } }] : [],
	});
});
