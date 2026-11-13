import { z } from "@hono/zod-openapi";

// Usage analytics over app-control usage.* (model call details / tool call details).
// Wire shapes mirror the SDK's usage types; paging defaults follow the usage contract
// (page 1, size 20, sort call_count desc).

export const UsageTimeRangeSchema = z
	.object({
		start_time: z.number().int().describe("Window start, Unix epoch milliseconds."),
		end_time: z.number().int().describe("Window end, Unix epoch milliseconds."),
	})
	.openapi("UsageTimeRange");

export const UsageScopeSchema = z
	.discriminatedUnion("type", [
		z.object({
			type: z.literal("workspace").describe("Aggregated usage across the listed workspaces."),
			workspace_ids: z.array(z.string()).min(1).describe("Workspaces to aggregate; at least one is required."),
			agent_id: z.string().optional().describe("Narrow the workspace aggregation to one Agent."),
		}),
		z.object({
			type: z.literal("agent").describe("Usage of one Agent (optionally a pinned version)."),
			agent_id: z.string(),
			workspace_ids: z
				.array(z.string())
				.optional()
				.describe("Optional single-workspace pin; omit to use the caller's identity workspace."),
			agent_version: z.string().optional(),
		}),
		z.object({
			type: z.literal("session").describe("Usage within one Session; its own window applies."),
			session_id: z.string(),
		}),
	])
	.openapi("UsageScope");

const usagePagination = {
	page_no: z.number().int().min(1).default(1).describe("1-based page number."),
	page_size: z.number().int().min(1).max(100).default(20).describe("Page size, 1..100."),
	sort_order: z.enum(["asc", "desc"]).default("desc"),
};

function refineUsageTimeRange<
	T extends { scope: { type: string }; time_range?: { start_time: number; end_time: number } },
>(value: T, ctx: z.RefinementCtx): void {
	if (value.scope.type === "session") {
		if (value.time_range) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["time_range"],
				message: "time_range is forbidden for session scope; the Session's own window is used.",
			});
		}
		return;
	}
	if (!value.time_range) {
		ctx.addIssue({
			code: z.ZodIssueCode.custom,
			path: ["time_range"],
			message: `time_range is required for ${value.scope.type} scope.`,
		});
	}
}

export const ListModelUsageRequestSchema = z
	.object({
		scope: UsageScopeSchema,
		time_range: UsageTimeRangeSchema.optional(),
		model_name: z.string().nullish().describe("Exact model name; omitted/null means all models."),
		...usagePagination,
		sort_by: z.enum(["call_count", "failed_count", "input_tokens", "output_tokens"]).default("call_count"),
	})
	.superRefine(refineUsageTimeRange)
	.openapi("ListModelUsageRequest");

export const ListToolUsageRequestSchema = z
	.object({
		scope: UsageScopeSchema,
		time_range: UsageTimeRangeSchema.optional(),
		source: z
			.enum(["builtin", "mcp", "custom"])
			.nullish()
			.describe("Exact tool source; omitted/null means all sources."),
		tool_name: z.string().nullish().describe("Exact tool name; omitted/null means all tools."),
		...usagePagination,
		sort_by: z.enum(["call_count", "failed_count"]).default("call_count"),
	})
	.superRefine(refineUsageTimeRange)
	.openapi("ListToolUsageRequest");

export const UsageTokenStatsSchema = z
	.object({
		input_tokens: z.number().int(),
		output_tokens: z.number().int(),
		cache_read_tokens: z.number().int(),
		cache_creation_tokens: z.number().int(),
		total_tokens: z.number().int(),
		cache_hit_ratio: z.number(),
	})
	.openapi("UsageTokenStats");

export const ModelUsageItemSchema = z
	.object({
		workspace_id: z.string(),
		model_name: z.string(),
		call_count: z.number().int(),
		failed_count: z.number().int(),
		tokens: UsageTokenStatsSchema,
	})
	.openapi("ModelUsageItem");

export const ToolUsageItemSchema = z
	.object({
		workspace_id: z.string(),
		tool_name: z.string(),
		source: z.string().describe("builtin | mcp | custom; unknown future values are preserved verbatim."),
		call_count: z.number().int(),
		failed_count: z.number().int(),
	})
	.openapi("ToolUsageItem");

// Header totals ride on the aggregates: token columns sum items[].tokens, the call
// total is total_call_count, and the paging count is total. No matches → empty items
// with zeroed totals.
export const ModelUsagePageSchema = z
	.object({
		items: z.array(ModelUsageItemSchema),
		total: z.number().int().describe("Total rows across all pages."),
		total_call_count: z.number().int().describe("Total calls across all pages."),
		page_no: z.number().int(),
		page_size: z.number().int(),
		data_updated_at: z.number().int().describe("Data freshness, Unix epoch milliseconds."),
	})
	.openapi("ModelUsagePage");

export const ToolUsagePageSchema = z
	.object({
		items: z.array(ToolUsageItemSchema),
		total: z.number().int().describe("Total rows across all pages."),
		total_call_count: z.number().int().describe("Total calls across all pages."),
		page_no: z.number().int(),
		page_size: z.number().int(),
		data_updated_at: z.number().int().describe("Data freshness, Unix epoch milliseconds."),
	})
	.openapi("ToolUsagePage");
