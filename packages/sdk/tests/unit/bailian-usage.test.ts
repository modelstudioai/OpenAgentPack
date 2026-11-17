import { afterEach, expect, test } from "bun:test";
import { createManagedApiContext, getUsageSummary } from "../../src/index.ts";
import { type FetchLike, setDefaultFetch } from "../../src/internal/transport.ts";
import type { UsageSummaryRequest } from "../../src/internal/types/usage.ts";

afterEach(() => setDefaultFetch(undefined));

const baseUrl = "https://bailian.test/api/v1/agentstudio";
const context = () => createManagedApiContext({ providers: { bailian: { api_key: "test", base_url: baseUrl } } });

const timeRange = { start_time: "2026-11-02T10:00:00+08:00", end_time: "2026-11-02T15:00:00+08:00" };
const metric = (value: number | null, unit = "count") => ({ value, unit });

const summary = {
	query_range: timeRange,
	data_updated_at: "2026-11-02T14:10:00+08:00",
	usage: {
		total: {
			input_tokens: metric(1000, "tokens"),
			output_tokens: metric(200, "tokens"),
			total_tokens: metric(1200, "tokens"),
			cache_read_tokens: metric(400, "tokens"),
			cache_creation_tokens: metric(100, "tokens"),
			cache_hit_ratio: metric(0.4, "ratio"),
			model_call_count: metric(5),
			tool_call_count: metric(3),
			builtin_tool_call_count: metric(0),
			mcp_tool_call_count: metric(3),
			custom_tool_call_count: metric(0),
			turns: metric(2),
			steps: metric(8),
			interrupt_error_count: metric(0),
			model_failed_count: metric(1),
			tool_failed_count: metric(1),
			runtime_ms: metric(60000, "ms"),
		},
		models: [
			{
				model_name: "qwen-plus",
				usage: {
					input_tokens: metric(1000, "tokens"),
					output_tokens: metric(200, "tokens"),
					total_tokens: metric(1200, "tokens"),
					cache_read_tokens: metric(400, "tokens"),
					cache_creation_tokens: metric(100, "tokens"),
					cache_hit_ratio: metric(0.4, "ratio"),
					call_count: metric(5),
					failed_count: metric(1),
				},
			},
		],
		tools: [
			{
				source: "mcp",
				tool_name: "web_search",
				usage: { call_count: metric(3), failed_count: metric(1) },
			},
		],
	},
};

const envelope = { request_id: "req_summary_example", data: summary };

function urlOf(input: Parameters<FetchLike>[0]) {
	return new URL(input instanceof Request ? input.url : input.toString());
}

test("workspace summary posts the dimension body and unwraps request_id/data", async () => {
	let path = "";
	const bodies: unknown[] = [];
	setDefaultFetch(async (input, init) => {
		path = urlOf(input).pathname;
		bodies.push(JSON.parse(String(init?.body ?? "{}")));
		return Response.json(envelope);
	});
	const result = await getUsageSummary(context(), { dimension: "workspace", time_range: timeRange });
	expect(path).toBe("/api/v1/agentstudio/usage/summary");
	expect(result).toEqual(envelope);
	expect(bodies[0]).toEqual({ dimension: "workspace", time_range: timeRange });
});

test("agent summary forwards agent_id, agent_version and granularity", async () => {
	let body: Record<string, unknown> | undefined;
	setDefaultFetch(async (_input, init) => {
		body = JSON.parse(String(init?.body ?? "{}"));
		return Response.json(envelope);
	});
	await getUsageSummary(context(), {
		dimension: "agent",
		agent_id: "agent_one",
		agent_version: null,
		time_range: timeRange,
		granularity: "day",
	});
	expect(body).toEqual({
		dimension: "agent",
		agent_id: "agent_one",
		agent_version: null,
		time_range: timeRange,
		granularity: "day",
	});
});

test("session summary sends only dimension/session_id and keeps null metrics as null", async () => {
	let body: Record<string, unknown> | undefined;
	setDefaultFetch(async (_input, init) => {
		body = JSON.parse(String(init?.body ?? "{}"));
		return Response.json({
			request_id: "req_session",
			data: {
				...summary,
				data_updated_at: null,
				usage: {
					...summary.usage,
					total: { ...summary.usage.total, input_tokens: metric(null, "tokens") },
					models: [],
					tools: [],
				},
			},
		});
	});
	const result = await getUsageSummary(context(), { dimension: "session", session_id: "sesn_one" });
	expect(body).toEqual({ dimension: "session", session_id: "sesn_one" });
	expect(result.data.usage.total.input_tokens).toEqual({ value: null, unit: "tokens" });
	expect(result.data.data_updated_at).toBeNull();
	expect(result.data.usage.models).toEqual([]);
});

test("usage requests reject cross-field violations before any HTTP call", async () => {
	let requests = 0;
	setDefaultFetch(async () => {
		requests += 1;
		return Response.json(envelope);
	});
	const ctx = context();
	const reject = (request: UsageSummaryRequest, message: string) =>
		expect(getUsageSummary(ctx, request)).rejects.toThrow(message);

	await reject({ dimension: "session", session_id: "sesn_one", time_range: timeRange }, "forbids time_range");
	await reject({ dimension: "session", session_id: "sesn_one", granularity: "day" }, "forbids granularity");
	await reject({ dimension: "session" }, "requires session_id");
	await reject({ dimension: "agent", time_range: timeRange }, "requires agent_id");
	await reject({ dimension: "agent", agent_id: "agent_one" }, "requires time_range");
	await reject({ dimension: "workspace" }, "requires time_range");
	await reject({ dimension: "workspace", time_range: timeRange, agent_id: "agent_one" }, "forbids agent_id");
	await reject({ dimension: "workspace", time_range: timeRange, session_id: "sesn_one" }, "forbids session_id");
	await reject(
		{ dimension: "workspace", time_range: { start_time: "2026-11-03T00:00:00+08:00", end_time: timeRange.start_time } },
		"before end_time",
	);
	await reject(
		{ dimension: "workspace", time_range: { start_time: "2026-11-02 10:00:00", end_time: timeRange.end_time } },
		"RFC 3339",
	);
	await reject(
		{ dimension: "workspace", time_range: timeRange, granularity: "week" as never },
		"Unknown usage granularity",
	);
	expect(requests).toBe(0);
});

test("a response without data is rejected instead of yielding an empty summary", async () => {
	setDefaultFetch(async () => Response.json({ request_id: "req_missing" }));
	await expect(getUsageSummary(context(), { dimension: "workspace", time_range: timeRange })).rejects.toThrow(
		"missing `data`",
	);
});

test("session summary may omit query_range and passes it through as absent", async () => {
	setDefaultFetch(async () =>
		Response.json({
			request_id: "req_session_no_range",
			data: {
				data_updated_at: null,
				usage: { total: summary.usage.total, models: [], tools: [] },
			},
		}),
	);
	const result = await getUsageSummary(context(), { dimension: "session", session_id: "sesn_one" });
	expect(result.data.query_range).toBeUndefined();
});

test("time_range rejects fractional seconds and offset-less local times", async () => {
	let requests = 0;
	setDefaultFetch(async () => {
		requests += 1;
		return Response.json(envelope);
	});
	const ctx = context();
	const reject = (request: UsageSummaryRequest, message: string) =>
		expect(getUsageSummary(ctx, request)).rejects.toThrow(message);

	await reject(
		{
			dimension: "workspace",
			time_range: { start_time: "2026-11-02T10:00:00.500+08:00", end_time: timeRange.end_time },
		},
		"RFC 3339",
	);
	await reject(
		{ dimension: "workspace", time_range: { start_time: "2026-11-02T10:00:00", end_time: timeRange.end_time } },
		"RFC 3339",
	);
	expect(requests).toBe(0);
});

test("blank identifiers, blank agent_version and explicit-null granularity are rejected", async () => {
	let requests = 0;
	setDefaultFetch(async () => {
		requests += 1;
		return Response.json(envelope);
	});
	const ctx = context();
	const reject = (request: UsageSummaryRequest, message: string) =>
		expect(getUsageSummary(ctx, request)).rejects.toThrow(message);

	await reject({ dimension: "agent", agent_id: "  ", time_range: timeRange }, "requires agent_id");
	await reject({ dimension: "session", session_id: " " }, "requires session_id");
	await reject(
		{ dimension: "agent", agent_id: "agent_one", agent_version: " ", time_range: timeRange },
		"agent_version",
	);
	await reject(
		{ dimension: "workspace", time_range: timeRange, granularity: null as never },
		"omitted rather than null",
	);
	expect(requests).toBe(0);
});

test("unsupported providers reject usage summary before making a request", async () => {
	const ctx = createManagedApiContext({ providers: { claude: { api_key: "test" } } });
	let requests = 0;
	setDefaultFetch(async () => {
		requests += 1;
		return Response.json(envelope);
	});
	await expect(getUsageSummary(ctx, { dimension: "workspace", time_range: timeRange })).rejects.toThrow(
		"does not support usage summary",
	);
	expect(requests).toBe(0);
});
