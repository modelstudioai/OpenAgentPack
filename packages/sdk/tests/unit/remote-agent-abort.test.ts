import { expect, test } from "bun:test";
import {
	createProjectRuntime,
	getRemoteAgent,
	resolveProjectConfigFromObject,
	StateManager,
	setDefaultFetch,
} from "../../src/index.ts";

test("Bailian Agent name lookup cancels the in-flight HTTP request and rejects pre-aborted work", async () => {
	let arrived!: () => void;
	const started = new Promise<void>((resolve) => {
		arrived = resolve;
	});
	let release!: (value: Response) => void;
	const response = new Promise<Response>((resolve) => {
		release = resolve;
	});
	const paths: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const url = new URL(request.url);
			paths.push(`${url.pathname}${url.search}`);
			arrived();
			return response;
		},
	});
	setDefaultFetch(undefined);
	try {
		const loaded = await resolveProjectConfigFromObject(
			{
				version: "1",
				providers: {
					bailian: { api_key: "unit-test", base_url: `http://127.0.0.1:${server.port}/api/v1/agentstudio` },
				},
				agents: {},
			},
			{ projectName: "remote-agent-abort" },
		);
		const context = createProjectRuntime({
			...loaded,
			state: StateManager.initialize("/tmp/unused-remote-agent-abort-state.json"),
		});
		const abort = new AbortController();
		const pending = getRemoteAgent(context, "agent_worker", { version: 3, signal: abort.signal });
		await started;
		abort.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		await expect(getRemoteAgent(context, "agent_worker", { signal: abort.signal })).rejects.toMatchObject({
			name: "AbortError",
		});
		expect(paths).toEqual(["/api/v1/agentstudio/agents/agent_worker?version=3"]);
	} finally {
		release(Response.json({ id: "agent_worker", name: "Worker" }));
		await server.stop(true);
		setDefaultFetch(undefined);
	}
});
