/**
 * Usage-query scope, discriminated by `type` (app-control usage.* endpoints):
 * - `workspace`: aggregated over the listed workspaces (overview page); `agent_id` narrows to one Agent.
 * - `agent`: one Agent (optionally a pinned version); `workspace_ids` may pin a single workspace,
 *   otherwise the caller's identity workspace is used.
 * - `session`: one Session; the Session's own window is used, so `time_range` is forbidden and
 *   `workspace_ids` (if sent) is ignored.
 */
export type UsageScope =
	| { type: "workspace"; workspace_ids: string[]; agent_id?: string }
	| { type: "agent"; agent_id: string; workspace_ids?: string[]; agent_version?: string }
	| { type: "session"; session_id: string };

/** Millisecond-precision epoch window. Required for workspace/agent scopes; forbidden for session. */
export interface UsageTimeRange {
	start_time: number;
	end_time: number;
}

export type ModelUsageSortBy = "call_count" | "failed_count" | "input_tokens" | "output_tokens";
export type ToolUsageSortBy = "call_count" | "failed_count";
export type UsageSortOrder = "asc" | "desc";

export interface ModelUsageRequest {
	scope: UsageScope;
	time_range?: UsageTimeRange;
	/** Exact model name; omitted/null means all models. */
	model_name?: string | null;
	/** 1-based page number. */
	page_no?: number;
	/** Page size, clamped to 1..100 by the endpoint. */
	page_size?: number;
	sort_by?: ModelUsageSortBy;
	sort_order?: UsageSortOrder;
}

export type UsageToolSource = "builtin" | "mcp" | "custom";

export interface ToolUsageRequest {
	scope: UsageScope;
	time_range?: UsageTimeRange;
	/** Exact tool source; omitted/null means all sources. Unknown provider values are preserved. */
	source?: UsageToolSource | null;
	/** Exact tool name; omitted/null means all tools. */
	tool_name?: string | null;
	page_no?: number;
	page_size?: number;
	/** Tool usage does not support token sorts — only call_count / failed_count. */
	sort_by?: ToolUsageSortBy;
	sort_order?: UsageSortOrder;
}

export interface UsageTokenStats {
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens: number;
	cache_creation_tokens: number;
	total_tokens: number;
	cache_hit_ratio: number;
}

/** One aggregated row. The paging key is workspace_id + model_name: the same model in different workspaces is not merged. */
export interface ModelUsageItem {
	workspace_id: string;
	model_name: string;
	call_count: number;
	failed_count: number;
	tokens: UsageTokenStats;
}

/** One aggregated row. The paging key is workspace_id + source + tool_name: same-name tools from different sources are separate rows. */
export interface ToolUsageItem {
	workspace_id: string;
	tool_name: string;
	/** builtin | mcp | custom; unknown future values are preserved verbatim. */
	source: string;
	call_count: number;
	failed_count: number;
}

/** Header totals come from the aggregates: token columns sum `items[].tokens`, the call total is `total_call_count`. */
export interface UsagePage<TItem> {
	items: TItem[];
	/** Total rows across all pages (the paging count). */
	total: number;
	/** Total calls across all pages (the headline "N calls" figure). */
	total_call_count: number;
	page_no: number;
	page_size: number;
	data_updated_at: number;
}

export type ModelUsagePage = UsagePage<ModelUsageItem>;
export type ToolUsagePage = UsagePage<ToolUsageItem>;

export interface UsageQueryOptions {
	signal?: AbortSignal;
}
