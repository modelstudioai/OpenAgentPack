import { UserError } from "../../errors.ts";
import type { UsageQueryOptions, UsageSummaryRequest, UsageSummaryResponse } from "../../types/usage.ts";
import type { BailianClient } from "./client.ts";

// The app-control usage RPC (`ziel:dashy::bailian-app-control.usage.summary`) is
// published as the AgentStudio summary endpoint below (Usage API reference:
// `POST /api/v1/agentstudio/usage/summary`). Model and tool details are two views
// of the same response, so one call covers both tables — there is no per-table
// endpoint, pagination or server-side name filter.
const SUMMARY_PATH = "/usage/summary";

const DIMENSIONS = new Set(["workspace", "agent", "session"]);
const GRANULARITIES = new Set(["hour", "day", "month"]);

/**
 * Cross-field request rules from the usage contract, enforced before the call:
 * - `workspace` requires a time_range and takes no agent/session;
 * - `agent` requires agent_id + time_range, may pin agent_version, takes no session;
 * - `session` requires session_id and forbids time_range/granularity/agent fields;
 * - `granularity` is only valid for `workspace`/`agent`.
 */
export function assertUsageRequest(request: UsageSummaryRequest): void {
	if (!DIMENSIONS.has(request.dimension)) {
		throw new UserError(`Unknown usage dimension '${request.dimension}'.`);
	}
	if (request.granularity !== undefined && !GRANULARITIES.has(request.granularity)) {
		throw new UserError(`Unknown usage granularity '${request.granularity}'.`);
	}
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
		if (!request.agent_id) throw new UserError("Usage dimension 'agent' requires agent_id.");
		return;
	}
	if (request.agent_id !== undefined || request.agent_version !== undefined) {
		throw new UserError("Usage dimension 'workspace' forbids agent_id and agent_version.");
	}
}

function assertSessionRequest(request: UsageSummaryRequest): void {
	if (!request.session_id) throw new UserError("Usage dimension 'session' requires session_id.");
	if (request.time_range !== undefined) {
		throw new UserError("Usage dimension 'session' forbids time_range; the Session's own window is used.");
	}
	if (request.granularity !== undefined) throw new UserError("Usage dimension 'session' forbids granularity.");
	if (request.agent_id !== undefined || request.agent_version !== undefined) {
		throw new UserError("Usage dimension 'session' forbids agent_id and agent_version.");
	}
}

/** RFC 3339 with an explicit offset; also rejects an empty or reversed window. */
function assertTimeRange(start: string, end: string): void {
	const startMs = Date.parse(start);
	const endMs = Date.parse(end);
	if (Number.isNaN(startMs) || Number.isNaN(endMs)) {
		throw new UserError("time_range must use RFC 3339 timestamps with an explicit offset.");
	}
	if (startMs >= endMs) throw new UserError("time_range start_time must be before end_time.");
}

/** The endpoint answers with `{ request_id, data: UsageSummary }`; `data` is mandatory. */
function unwrapSummary(result: unknown): UsageSummaryResponse {
	const body = result as Partial<UsageSummaryResponse> | null;
	const data = body?.data;
	if (!data) throw new UserError("Usage summary response is missing `data`.");
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
