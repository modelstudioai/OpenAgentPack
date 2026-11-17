import { UserError } from "../../errors.ts";
import type {
	UsageQueryOptions,
	UsageSummaryRequest,
	UsageSummaryResponse,
	UsageTrendRequest,
	UsageTrendResponse,
} from "../../types/usage.ts";
import type { BailianClient } from "./client.ts";

// The app-control usage RPC (`ziel:dashy::bailian-app-control.usage.summary`) is
// published as the AgentStudio summary endpoint below (Usage API reference:
// `POST /api/v1/agentstudio/usage/summary`). Model and tool details are two views
// of the same response, so one call covers both tables — there is no per-table
// endpoint, pagination or server-side name filter. The trend endpoint
// (`POST /api/v1/agentstudio/usage/trend`) serves the same breakdown per bucket,
// cursor-paged and without a `session` dimension.
const SUMMARY_PATH = "/usage/summary";
const TREND_PATH = "/usage/trend";

const SUMMARY_DIMENSIONS = new Set(["workspace", "agent", "session"]);
const TREND_DIMENSIONS = new Set(["workspace", "agent"]);
const GRANULARITIES = new Set(["hour", "day", "month"]);
const MAX_PAGE_SIZE = 100;

// Second precision with an explicit offset; fractional seconds and offset-less
// local times are rejected by the contract before reaching the server.
const RFC3339_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:Z|[+-]\d{2}:\d{2})$/;

const blank = (value: string | null | undefined): boolean => value == null || value.trim() === "";

/**
 * Cross-field request rules from the usage contract, enforced before the call:
 * - `workspace` requires a time_range and takes no agent/session;
 * - `agent` requires agent_id + time_range, may pin agent_version, takes no session;
 * - `session` requires session_id and forbids time_range/granularity/agent fields;
 * - `granularity` is only valid for `workspace`/`agent`.
 */
export function assertUsageRequest(request: UsageSummaryRequest): void {
	if (!SUMMARY_DIMENSIONS.has(request.dimension)) {
		throw new UserError(`Unknown usage dimension '${request.dimension}'.`);
	}
	assertGranularity(request.granularity);
	if (request.dimension === "session") {
		assertSessionRequest(request);
		return;
	}
	if (request.session_id !== undefined) {
		throw new UserError(`Usage dimension '${request.dimension}' forbids session_id.`);
	}
	if (!request.time_range) {
		throw new UserError(`Usage dimension '${request.dimension}' requires time_range.`);
	}
	assertTimeRange(request.time_range.start_time, request.time_range.end_time);
	if (request.dimension === "agent") {
		if (blank(request.agent_id)) throw new UserError("Usage dimension 'agent' requires agent_id.");
		assertAgentVersion(request.agent_version);
		return;
	}
	if (request.agent_id !== undefined || request.agent_version !== undefined) {
		throw new UserError("Usage dimension 'workspace' forbids agent_id and agent_version.");
	}
}

/**
 * Trend rules: no `session` dimension, time_range always required, agent fields
 * only for `agent`, and cursor pagination bounded by the contract.
 */
export function assertUsageTrendRequest(request: UsageTrendRequest): void {
	if (!TREND_DIMENSIONS.has(request.dimension)) {
		throw new UserError(
			`Unknown usage trend dimension '${request.dimension}'; trend supports 'workspace' and 'agent'.`,
		);
	}
	assertGranularity(request.granularity);
	if (!request.time_range) {
		throw new UserError(`Usage trend dimension '${request.dimension}' requires time_range.`);
	}
	assertTimeRange(request.time_range.start_time, request.time_range.end_time);
	if (request.dimension === "agent") {
		if (blank(request.agent_id)) throw new UserError("Usage trend dimension 'agent' requires agent_id.");
		assertAgentVersion(request.agent_version);
	} else if (request.agent_id !== undefined || request.agent_version !== undefined) {
		throw new UserError("Usage trend dimension 'workspace' forbids agent_id and agent_version.");
	}
	if (
		request.page_size !== undefined &&
		(!Number.isInteger(request.page_size) || request.page_size < 1 || request.page_size > MAX_PAGE_SIZE)
	) {
		throw new UserError(`page_size must be an integer between 1 and ${MAX_PAGE_SIZE}.`);
	}
	if (request.page_token !== undefined && (typeof request.page_token !== "string" || blank(request.page_token))) {
		throw new UserError("page_token must be a non-empty cursor string.");
	}
}

function assertSessionRequest(request: UsageSummaryRequest): void {
	if (blank(request.session_id)) throw new UserError("Usage dimension 'session' requires session_id.");
	if (request.time_range !== undefined) {
		throw new UserError("Usage dimension 'session' forbids time_range; the Session's own window is used.");
	}
	if (request.granularity !== undefined) throw new UserError("Usage dimension 'session' forbids granularity.");
	if (request.agent_id !== undefined || request.agent_version !== undefined) {
		throw new UserError("Usage dimension 'session' forbids agent_id and agent_version.");
	}
}

function assertGranularity(granularity: unknown): void {
	if (granularity === null) {
		throw new UserError("usage granularity must be omitted rather than null; the server picks it from the span.");
	}
	if (granularity !== undefined && !GRANULARITIES.has(granularity as string)) {
		throw new UserError(`Unknown usage granularity '${String(granularity)}'.`);
	}
}

function assertAgentVersion(agentVersion: string | null | undefined): void {
	if (agentVersion != null && blank(agentVersion)) {
		throw new UserError("agent_version must be a version string or null.");
	}
}

/** Second-precision RFC 3339 with an explicit offset; also rejects a reversed window. */
function assertTimeRange(start: string, end: string): void {
	const message =
		"time_range must use second-precision RFC 3339 timestamps with an explicit offset, e.g. 2026-11-02T10:00:00+08:00.";
	if (
		typeof start !== "string" ||
		typeof end !== "string" ||
		!RFC3339_SECONDS.test(start) ||
		!RFC3339_SECONDS.test(end)
	) {
		throw new UserError(message);
	}
	const startMs = Date.parse(start);
	const endMs = Date.parse(end);
	if (Number.isNaN(startMs) || Number.isNaN(endMs)) throw new UserError(message);
	if (startMs >= endMs) throw new UserError("time_range start_time must be before end_time.");
}

/** The summary endpoint answers with `{ request_id, data: UsageSummary }`; `data` is mandatory. */
function unwrapSummary(result: unknown): UsageSummaryResponse {
	const body = result as Partial<UsageSummaryResponse> | null;
	const data = body?.data;
	if (!data) throw new UserError("Usage summary response is missing `data`.");
	return { request_id: body.request_id ?? "", data };
}

/** The trend endpoint answers with `{ request_id, data: UsageTrend }`; `data` is mandatory. */
function unwrapTrend(result: unknown): UsageTrendResponse {
	const body = result as Partial<UsageTrendResponse> | null;
	const data = body?.data;
	if (!data) throw new UserError("Usage trend response is missing `data`.");
	return { request_id: body.request_id ?? "", data };
}

export async function getBailianUsageSummary(
	client: BailianClient,
	request: UsageSummaryRequest,
	options: UsageQueryOptions = {},
): Promise<UsageSummaryResponse> {
	assertUsageRequest(request);
	const result = await client.post(SUMMARY_PATH, request, options.signal ? { signal: options.signal } : undefined);
	return unwrapSummary(result);
}

export async function getBailianUsageTrend(
	client: BailianClient,
	request: UsageTrendRequest,
	options: UsageQueryOptions = {},
): Promise<UsageTrendResponse> {
	assertUsageTrendRequest(request);
	const result = await client.post(TREND_PATH, request, options.signal ? { signal: options.signal } : undefined);
	return unwrapTrend(result);
}
