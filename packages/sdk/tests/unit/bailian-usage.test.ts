import { afterEach, expect, test } from "bun:test";
import { createManagedApiContext, listModelUsage, listToolUsage } from "../../src/index.ts";
import { type FetchLike, setDefaultFetch } from "../../src/internal/transport.ts";
import type { UsageScope } from "../../src/internal/types/usage.ts";

afterEach(() => setDefaultFetch(undefined));

const baseUrl = "https://bailian.test/api/v1/agentstudio";
const context = () => createManagedApiContext({ providers: { bailian: { api_key: "test", base_url: baseUrl } } });

const workspaceScope: UsageScope = { type: "workspace", workspace_ids: ["ws_one"] };
const timeRange = { start_time: 1791730260000, end_time: 1792335080000 };

const modelPage = {
	items: [
		{
			workspace_id: "ws_one",
			model_name: "qwen3-max",
			call_count: 14,
			failed_count: 2,
			tokens: {
				input_tokens: 268080,
				output_tokens: 7506,
				cache_read_tokens: 164000,
				cache_creation_tokens: 0,
				total_tokens: 275500,
				cache_hit_ratio: 0.61194,
			},
		},
	],
	total: 1,
	total_call_count: 14,
	page_no: 1,
	page_size: 20,
	data_updated_at: 1792328000000,
};

const toolPage = {
	items: [{ workspace_id: "ws_one", tool_name: "file-parser", source: "mcp", call_count: 4, failed_count: 2 }],
	total: 1,
	total_call_count: 6,
	page_no: 1,
	page_size: 20,
	data_updated_at: 1792328000000,
};

function urlOf(input: Parameters<FetchLike>[0]) {
	return new URL(input instanceof Request ? input.url : input.toString());
}

test("model usage posts a top-level body on the resource path and unwraps the data page", async () => {
	let path = "";
	const bodies: unknown[] = [];
	setDefaultFetch(async (input, init) => {
		path = urlOf(input).pathname;
		bodies.push(JSON.parse(String(init?.body ?? "{}")));
		return Response.json({ data: modelPage });
	});
	const page = await listModelUsage(context(), {
		scope: workspaceScope,
		time_range: timeRange,
		page_no: 2,
		page_size: 50,
		sort_by: "input_tokens",
		sort_order: "asc",
	});
	expect(path).toBe("/api/v1/agentstudio/usage/models");
	expect(page).toEqual(modelPage);
	expect(bodies[0]).toEqual({
		scope: workspaceScope,
		time_range: timeRange,
		page_no: 2,
		page_size: 50,
		sort_by: "input_tokens",
		sort_order: "asc",
	});
});

test("tool usage forwards source/tool filters and tolerates a bare page without the data envelope", async () => {
	let path = "";
	let body: Record<string, unknown> | undefined;
	setDefaultFetch(async (input, init) => {
		path = urlOf(input).pathname;
		body = JSON.parse(String(init?.body ?? "{}"));
		return Response.json(toolPage);
	});
	const page = await listToolUsage(context(), {
		scope: { type: "agent", agent_id: "agent_one" },
		time_range: timeRange,
		source: "mcp",
		tool_name: "file-parser",
	});
	expect(path).toBe("/api/v1/agentstudio/usage/tools");
	expect(body).toEqual({
		scope: { type: "agent", agent_id: "agent_one" },
		time_range: timeRange,
		source: "mcp",
		tool_name: "file-parser",
	});
	expect(page).toEqual(toolPage);
});

test("usage requests reject cross-field violations before any HTTP call", async () => {
	let requests = 0;
	setDefaultFetch(async () => {
		requests += 1;
		return Response.json({ data: modelPage });
	});
	const ctx = context();
	await expect(
		listModelUsage(ctx, { scope: { type: "session", session_id: "sesn_one" }, time_range: timeRange }),
	).rejects.toThrow("forbids time_range");
	await expect(listModelUsage(ctx, { scope: { type: "agent", agent_id: "agent_one" } })).rejects.toThrow(
		"requires time_range",
	);
	await expect(
		listModelUsage(ctx, { scope: { type: "workspace", workspace_ids: [] }, time_range: timeRange }),
	).rejects.toThrow("non-empty workspace_ids");
	await expect(listToolUsage(ctx, { scope: workspaceScope, time_range: timeRange, page_size: 101 })).rejects.toThrow(
		"between 1 and 100",
	);
	expect(requests).toBe(0);
});

test("unsupported providers reject usage operations before making a request", async () => {
	const ctx = createManagedApiContext({ providers: { claude: { api_key: "test" } } });
	let requests = 0;
	setDefaultFetch(async () => {
		requests += 1;
		return Response.json({ data: modelPage });
	});
	await expect(listModelUsage(ctx, { scope: workspaceScope, time_range: timeRange })).rejects.toThrow(
		"does not support model usage listing",
	);
	await expect(listToolUsage(ctx, { scope: workspaceScope, time_range: timeRange })).rejects.toThrow(
		"does not support tool usage listing",
	);
	expect(requests).toBe(0);
});
