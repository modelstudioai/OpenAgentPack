import { afterEach, expect, test } from "bun:test";
import { createManagedApiContext, getUsageTrend } from "../../src/index.ts";
import { type FetchLike, setDefaultFetch } from "../../src/internal/transport.ts";
import type { UsageTrendRequest } from "../../src/internal/types/usage.ts";

afterEach(() => setDefaultFetch(undefined));

const baseUrl = "https://bailian.test/api/v1/agentstudio";
const context = () => createManagedApiContext({ providers: { bailian: { api_key: "test", base_url: baseUrl } } });

const timeRange = { start_time: "2026-11-02T10:00:00+08:00", end_time: "2026-11-02T15:00:00+08:00" };
const metric = (value: number | null, unit = "count") => ({ value, unit });

const total = {
	input_tokens: metric(100, "tokens"),
	output_tokens: metric(20, "tokens"),
	total_tokens: metric(120, "tokens"),
	cache_read_tokens: metric(0, "tokens"),
	cache_creation_tokens: metric(0, "tokens"),
	cache_hit_ratio: metric(null, "ratio"),
	model_call_count: metric(1),
	tool_call_count: metric(1),
	builtin_tool_call_count: metric(0),
	mcp_tool_call_count: metric(0),
	custom_tool_call_count: metric(1),
	turns: metric(1),
	steps: metric(2),
	interrupt_error_count: metric(0),
	model_failed_count: metric(0),
	tool_failed_count: metric(0),
	runtime_ms: metric(3000, "ms"),
};

const trend = {
	query_range: timeRange,
	data_updated_at: "2026-11-02T15:02:00+08:00",
	granularity: "hour",
	points: [
		{
			start_time: "2026-11-02T10:00:00+08:00",
			end_time: "2026-11-02T11:00:00+08:00",
			usage: {
				total,
				models: [{ model_name: "qwen-plus", usage: { input_tokens: metric(100, "tokens") } }],
				tools: [{ source: "mcp", tool_name: "web_search", usage: { call_count: metric(1), failed_count: metric(0) } }],
			},
		},
	],
	has_more: true,
	next_page_token: "cursor_2",
};

const envelope = { request_id: "req_trend_example", data: trend };

function urlOf(input: Parameters<FetchLike>[0]) {
	return new URL(input instanceof Request ? input.url : input.toString());
}

test("workspace trend posts the cursor body and unwraps request_id/data", async () => {
	let path = "";
	const bodies: unknown[] = [];
	setDefaultFetch(async (input, init) => {
		path = urlOf(input).pathname;
		bodies.push(JSON.parse(String(init?.body ?? "{}")));
		return Response.json(envelope);
	});
	const request: UsageTrendRequest = {
		dimension: "workspace",
		time_range: timeRange,
		granularity: "hour",
		page_size: 20,
		page_token: "cursor_1",
	};
	const result = await getUsageTrend(context(), request);
	expect(path).toBe("/api/v1/agentstudio/usage/trend");
	expect(bodies[0]).toEqual(request);
	expect(result).toEqual(envelope);
	expect(result.data.points).toHaveLength(1);
	expect(result.data.next_page_token).toBe("cursor_2");
});

test("agent trend forwards agent_version null without inventing paging fields", async () => {
	let body: Record<string, unknown> | undefined;
	setDefaultFetch(async (_input, init) => {
		body = JSON.parse(String(init?.body ?? "{}"));
		return Response.json(envelope);
	});
	await getUsageTrend(context(), {
		dimension: "agent",
		agent_id: "agent_one",
		agent_version: null,
		time_range: timeRange,
	});
	expect(body).toEqual({
		dimension: "agent",
		agent_id: "agent_one",
		agent_version: null,
		time_range: timeRange,
	});
});

test("trend requests reject contract violations before any HTTP call", async () => {
	let requests = 0;
	setDefaultFetch(async () => {
		requests += 1;
		return Response.json(envelope);
	});
	const ctx = context();
	const reject = (request: UsageTrendRequest, message: string) =>
		expect(getUsageTrend(ctx, request)).rejects.toThrow(message);

	await reject({ dimension: "session", time_range: timeRange } as never, "Unknown usage trend dimension");
	await reject({ dimension: "workspace" } as never, "requires time_range");
	await reject({ dimension: "workspace", agent_id: "agent_one", time_range: timeRange }, "forbids agent_id");
	await reject({ dimension: "agent", time_range: timeRange }, "requires agent_id");
	await reject({ dimension: "agent", agent_id: "  ", time_range: timeRange }, "requires agent_id");
	await reject(
		{ dimension: "agent", agent_id: "agent_one", agent_version: " ", time_range: timeRange },
		"agent_version",
	);
	await reject(
		{ dimension: "workspace", time_range: timeRange, granularity: "week" as never },
		"Unknown usage granularity",
	);
	await reject(
		{ dimension: "workspace", time_range: timeRange, granularity: null as never },
		"omitted rather than null",
	);
	await reject({ dimension: "workspace", time_range: timeRange, page_size: 0 }, "between 1 and 100");
	await reject({ dimension: "workspace", time_range: timeRange, page_size: 101 }, "between 1 and 100");
	await reject({ dimension: "workspace", time_range: timeRange, page_size: 1.5 }, "between 1 and 100");
	await reject({ dimension: "workspace", time_range: timeRange, page_token: " " }, "non-empty cursor");
	await reject(
		{
			dimension: "workspace",
			time_range: { start_time: "2026-11-02 10:00:00", end_time: timeRange.end_time },
		},
		"RFC 3339",
	);
	await reject(
		{ dimension: "workspace", time_range: { start_time: timeRange.end_time, end_time: timeRange.start_time } },
		"before end_time",
	);
	expect(requests).toBe(0);
});

test("a trend response without data is rejected instead of yielding empty points", async () => {
	setDefaultFetch(async () => Response.json({ request_id: "req_missing" }));
	await expect(getUsageTrend(context(), { dimension: "workspace", time_range: timeRange })).rejects.toThrow(
		"missing `data`",
	);
});

test("unsupported providers reject usage trend before making a request", async () => {
	const ctx = createManagedApiContext({ providers: { claude: { api_key: "test" } } });
	let requests = 0;
	setDefaultFetch(async () => {
		requests += 1;
		return Response.json(envelope);
	});
	await expect(getUsageTrend(ctx, { dimension: "workspace", time_range: timeRange })).rejects.toThrow(
		"does not support usage trend",
	);
	expect(requests).toBe(0);
});
