/**
 * Usage summary scope, discriminated by `dimension` (app-control usage.summary):
 * - `workspace`: aggregated over the caller's workspace; `agent_id` narrows to one Agent.
 * - `agent`: one Agent (optionally a pinned version).
 * - `session`: one Session; its lifecycle totals are used, so `time_range` and
 *   `granularity` must not be sent.
 */
export type UsageDimension = "workspace" | "agent" | "session";

/** Bucket size of the returned `query_range`; omitted lets the server pick from the span. */
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
 * Aggregated usage for one scope. `total`, `models` and `tools` are three views
 * of the same query — never add the total to the detail rows.
 */
export interface UsageSummary {
	/** Effective window after the server aligned it to `granularity` (UTC+8). */
	query_range: UsageTimeRange;
	/** Latest known data refresh time; null when no statistics exist. */
	data_updated_at: string | null;
	usage: {
		total: UsageTotal;
		models: UsageModelRow[];
		tools: UsageToolRow[];
	};
}

export interface UsageSummaryResponse {
	/** Server-side request id, kept for support triage. */
	request_id: string;
	data: UsageSummary;
}

export interface UsageQueryOptions {
	signal?: AbortSignal;
}
