import { z } from "@hono/zod-openapi";

// Usage analytics over app-control usage.summary. Wire shapes mirror the SDK's usage
// types: one call returns scope totals plus the model/tool breakdown views, so no
// per-table paging or sorting parameters exist anymore.

export const UsageDimensionSchema = z.enum(["workspace", "agent", "session"]).openapi("UsageDimension");

export const UsageTimeRangeSchema = z
	.object({
		start_time: z.string().describe("Window start, RFC 3339 with an explicit offset (UTC+8 aligned)."),
		end_time: z.string().describe("Window end, RFC 3339 with an explicit offset (UTC+8 aligned)."),
	})
	.openapi("UsageTimeRange");

export const UsageGranularitySchema = z.enum(["hour", "day", "month"]).openapi("UsageGranularity");

export const GetUsageSummaryRequestSchema = z
	.object({
		dimension: UsageDimensionSchema,
		agent_id: z.string().optional().describe("Required for the agent dimension; forbidden for session."),
		agent_version: z.string().nullish().describe("Only meaningful for the agent dimension; null means every version."),
		session_id: z.string().optional().describe("Required for the session dimension; forbidden otherwise."),
		time_range: UsageTimeRangeSchema.optional().describe("Required for workspace/agent; forbidden for session."),
		granularity: UsageGranularitySchema.optional().describe("Only for workspace/agent; forbidden for session."),
	})
	.superRefine((value, ctx) => {
		if (value.dimension === "session") {
			if (value.agent_id) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["agent_id"],
					message: "agent_id is forbidden for session dimension.",
				});
			}
			if (value.time_range) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["time_range"],
					message: "time_range is forbidden for session dimension; the Session's own window is used.",
				});
			}
			if (value.granularity) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["granularity"],
					message: "granularity is forbidden for session dimension.",
				});
			}
			if (!value.session_id) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["session_id"],
					message: "session_id is required for session dimension.",
				});
			}
			return;
		}
		if (value.session_id) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["session_id"],
				message: "session_id is forbidden for workspace/agent dimension.",
			});
		}
		if (!value.time_range) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["time_range"],
				message: `time_range is required for ${value.dimension} dimension.`,
			});
		}
		if (value.dimension === "agent" && !value.agent_id) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["agent_id"],
				message: "agent_id is required for agent dimension.",
			});
		}
	})
	.openapi("GetUsageSummaryRequest");

/** Every indicator carries its own unit; unknown indicators keep their unit with a null value. */
export const UsageMetricSchema = z.object({ value: z.number().nullable(), unit: z.string() }).openapi("UsageMetric");

export const UsageTotalSchema = z
	.object({
		input_tokens: UsageMetricSchema,
		output_tokens: UsageMetricSchema,
		total_tokens: UsageMetricSchema,
		cache_read_tokens: UsageMetricSchema,
		cache_creation_tokens: UsageMetricSchema,
		cache_hit_ratio: UsageMetricSchema,
		model_call_count: UsageMetricSchema,
		tool_call_count: UsageMetricSchema,
		builtin_tool_call_count: UsageMetricSchema,
		mcp_tool_call_count: UsageMetricSchema,
		custom_tool_call_count: UsageMetricSchema,
		turns: UsageMetricSchema,
		steps: UsageMetricSchema,
		interrupt_error_count: UsageMetricSchema,
		model_failed_count: UsageMetricSchema,
		tool_failed_count: UsageMetricSchema,
		runtime_ms: UsageMetricSchema,
	})
	.openapi("UsageTotal");

export const UsageModelRowSchema = z
	.object({
		model_name: z.string().nullable().describe("Null when the provider could not attribute the calls."),
		usage: z.object({
			input_tokens: UsageMetricSchema,
			output_tokens: UsageMetricSchema,
			total_tokens: UsageMetricSchema,
			cache_read_tokens: UsageMetricSchema,
			cache_creation_tokens: UsageMetricSchema,
			cache_hit_ratio: UsageMetricSchema,
			call_count: UsageMetricSchema,
			failed_count: UsageMetricSchema,
		}),
	})
	.openapi("UsageModelRow");

export const UsageToolRowSchema = z
	.object({
		source: z.string().nullable().describe("builtin | mcp | custom; unknown future values are preserved verbatim."),
		tool_name: z.string().nullable(),
		usage: z.object({ call_count: UsageMetricSchema, failed_count: UsageMetricSchema }),
	})
	.openapi("UsageToolRow");

// total, models and tools are three views of the same query — never add the total to the detail rows.
export const UsageSummarySchema = z
	.object({
		query_range: UsageTimeRangeSchema.optional(),
		data_updated_at: z.string().nullable().describe("Data freshness; null when no statistics exist."),
		usage: z.object({
			total: UsageTotalSchema,
			models: z.array(UsageModelRowSchema),
			tools: z.array(UsageToolRowSchema),
		}),
	})
	.openapi("UsageSummary");

export const UsageSummaryResponseSchema = z
	.object({
		request_id: z.string().describe("Server-side request id, kept for support triage."),
		data: UsageSummarySchema,
	})
	.openapi("UsageSummaryResponse");
