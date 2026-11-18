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

// Request validation mirrors the SDK usage contract so malformed payloads get a 400
// from the route schema instead of an SDK UserError surfacing as a 500: second-precision
// RFC 3339 timestamps (fractional seconds and offset-less times rejected), blank
// identifiers rejected, impossible calendar dates rejected, and one strict branch per
// dimension so cross-dimension fields fail as unknown keys.
const RFC3339_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/;
const CALENDAR_DATE_PREFIX = /^(\d{4})-(\d{2})-(\d{2})T/;

function isRealCalendarDate(value: string): boolean {
	const match = CALENDAR_DATE_PREFIX.exec(value);
	if (!match) return false;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	if (month < 1 || month > 12) return false;
	return day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

const UsageTimestampSchema = z
	.string()
	.regex(
		RFC3339_SECONDS,
		"must be a second-precision RFC 3339 timestamp with an explicit offset, e.g. 2026-11-02T10:00:00+08:00.",
	);

const UsageRequestTimeRangeSchema = z
	.object({
		start_time: UsageTimestampSchema.describe("Window start, RFC 3339 with an explicit offset (UTC+8 aligned)."),
		end_time: UsageTimestampSchema.describe("Window end, RFC 3339 with an explicit offset (UTC+8 aligned)."),
	})
	.openapi("UsageRequestTimeRange");

const nonBlank = (message: string) => z.string().refine((value) => value.trim() !== "", message);

const WorkspaceSummaryRequestSchema = z
	.object({
		dimension: z.literal("workspace"),
		time_range: UsageRequestTimeRangeSchema.describe("Required for the workspace dimension."),
		granularity: UsageGranularitySchema.optional().describe("Omit to let the server pick the bucket from the span."),
	})
	.strict();

const AgentSummaryRequestSchema = z
	.object({
		dimension: z.literal("agent"),
		agent_id: nonBlank("agent_id must not be blank.").describe("Required for the agent dimension."),
		agent_version: z
			.union([
				nonBlank("agent_version must be a version string or null.").describe("Pinned agent version."),
				z.null().describe("Null means every version."),
			])
			.optional(),
		time_range: UsageRequestTimeRangeSchema.describe("Required for the agent dimension."),
		granularity: UsageGranularitySchema.optional().describe("Omit to let the server pick the bucket from the span."),
	})
	.strict();

const SessionSummaryRequestSchema = z
	.object({
		dimension: z.literal("session"),
		session_id: nonBlank("session_id must not be blank.").describe("Required for the session dimension."),
	})
	.strict();

export const GetUsageSummaryRequestSchema = z
	.discriminatedUnion("dimension", [
		WorkspaceSummaryRequestSchema,
		AgentSummaryRequestSchema,
		SessionSummaryRequestSchema,
	])
	.superRefine((value, ctx) => {
		if (value.dimension === "session") return;
		const { start_time: start, end_time: end } = value.time_range;
		if (!isRealCalendarDate(start) || !isRealCalendarDate(end)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["time_range"],
				message: "time_range timestamps must name real calendar dates.",
			});
			return;
		}
		if (Date.parse(start) >= Date.parse(end)) {
			ctx.addIssue({
				code: z.ZodIssueCode.custom,
				path: ["time_range", "end_time"],
				message: "time_range start_time must be before end_time.",
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
