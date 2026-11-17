/**
 * Usage summary scope, discriminated by `dimension` (app-control usage.summary):
 * - `workspace`: aggregated over the caller's whole workspace; no agent/session narrowing.
 * - `agent`: one Agent (optionally a pinned version).
 * - `session`: one Session; its lifecycle totals are used, so `time_range` and
 *   `granularity` must not be sent.
 */
export type UsageDimension = "workspace" | "agent" | "session";

/** Trend scope: the trend endpoint has no `session` dimension. */
export type UsageTrendDimension = "workspace" | "agent";

/**
 * Bucket size of `query_range` and trend points. Omit it and the server picks
 * from the span; do not send an explicit `null`.
 */
export type UsageGranularity = "hour" | "day" | "month";

/** RFC 3339 window carrying an explicit offset, e.g. `2026-11-02T10:00:00+08:00`. */
export interface UsageTimeRange {
	start_time: string;
	end_time: string;
}

export interface UsageSummaryRequest {
	dimension: UsageDimension;
	/** Required for the `agent` dimension; forbidden for `session`. */
	agent_id?: string;
	/** Only meaningful for the `agent` dimension; null means every version. */
	agent_version?: string | null;
	/** Required for the `session` dimension; forbidden for `workspace`/`agent`. */
	session_id?: string;
	/** Required for `workspace`/`agent`; forbidden for `session` (the Session window is used). */
	time_range?: UsageTimeRange;
	/** Only for `workspace`/`agent`; forbidden for `session`. */
	granularity?: UsageGranularity;
}

/** Bucketed trend for `workspace`/`agent`; `session` has no trend dimension. */
export interface UsageTrendRequest {
	dimension: UsageTrendDimension;
	/** Required for the `agent` dimension; forbidden for `workspace`. */
	agent_id?: string;
	/** Only meaningful for the `agent` dimension; null means every version. */
	agent_version?: string | null;
	time_range: UsageTimeRange;
	/** Omit to let the server pick the bucket from the span; never send null. */
	granularity?: UsageGranularity;
	/** Page size 1..100; omitted means the server default (100). */
	page_size?: number;
	/** Opaque cursor from the previous page's `next_page_token`; valid for 15 minutes. */
	page_token?: string;
}

/**
 * Every indicator carries its own unit. An unknown indicator keeps its unit with a
 * `null` value; a known zero stays `0` and must not be treated as unknown.
 */
export interface UsageMetric {
	value: number | null;
	unit: string;
}

/** Per-model indicators (`usage.models[].usage`). */
export interface UsageModelMetrics {
	input_tokens: UsageMetric;
	output_tokens: UsageMetric;
	total_tokens: UsageMetric;
	cache_read_tokens: UsageMetric;
	cache_creation_tokens: UsageMetric;
	cache_hit_ratio: UsageMetric;
	call_count: UsageMetric;
	failed_count: UsageMetric;
}

/** Per-tool indicators (`usage.tools[].usage`); tools carry no token or runtime columns. */
export interface UsageToolMetrics {
	call_count: UsageMetric;
	failed_count: UsageMetric;
}

/** Whole-scope indicators (`usage.total`). */
export interface UsageTotal {
	input_tokens: UsageMetric;
	output_tokens: UsageMetric;
	total_tokens: UsageMetric;
	cache_read_tokens: UsageMetric;
	cache_creation_tokens: UsageMetric;
	cache_hit_ratio: UsageMetric;
	model_call_count: UsageMetric;
	tool_call_count: UsageMetric;
	builtin_tool_call_count: UsageMetric;
	mcp_tool_call_count: UsageMetric;
	custom_tool_call_count: UsageMetric;
	turns: UsageMetric;
	steps: UsageMetric;
	interrupt_error_count: UsageMetric;
	model_failed_count: UsageMetric;
	tool_failed_count: UsageMetric;
	runtime_ms: UsageMetric;
}

/**
 * One aggregated model row. `model_name` is null when the provider could not
 * attribute the calls; ordering is not guaranteed.
 */
export interface UsageModelRow {
	model_name: string | null;
	usage: UsageModelMetrics;
}

/**
 * One aggregated tool row. Rows are keyed by `source` + `tool_name`, so
 * same-name tools from different sources stay separate.
 */
export interface UsageToolRow {
	source: string | null;
	tool_name: string | null;
	usage: UsageToolMetrics;
}

/**
 * `total`, `models` and `tools` are three views of the same query — never add
 * the total to the detail rows.
 */
export interface UsageBreakdown {
	total: UsageTotal;
	models: UsageModelRow[];
	tools: UsageToolRow[];
}

/** Aggregated usage for one scope (summary endpoint). */
export interface UsageSummary {
	/**
	 * Effective window after the server aligned it to `granularity` (UTC+8).
	 * The `session` dimension has no caller-supplied window and may omit it.
	 */
	query_range?: UsageTimeRange;
	/** Latest known data refresh time; null when no statistics exist. */
	data_updated_at: string | null;
	usage: UsageBreakdown;
}

export interface UsageSummaryResponse {
	/** Server-side request id, kept for support triage. */
	request_id: string;
	data: UsageSummary;
}

/** One trend bucket. Buckets without data are omitted, not zero-filled. */
export interface UsageTrendPoint {
	start_time: string;
	end_time: string;
	usage: UsageBreakdown;
}

/** One page of trend buckets; `total/models/tools` describe that bucket only. */
export interface UsageTrend {
	/** Effective window after the server aligned it to `granularity` (UTC+8). */
	query_range: UsageTimeRange;
	data_updated_at: string | null;
	granularity: UsageGranularity;
	points: UsageTrendPoint[];
	has_more: boolean;
	/** Cursor for the next page; null on the last page or when it expired. */
	next_page_token: string | null;
}

export interface UsageTrendResponse {
	/** Server-side request id, kept for support triage. */
	request_id: string;
	data: UsageTrend;
}

export interface UsageQueryOptions {
	signal?: AbortSignal;
}
