import { UserError } from "../../errors.ts";
import type {
	ModelUsagePage,
	ModelUsageRequest,
	ToolUsagePage,
	ToolUsageRequest,
	UsageQueryOptions,
	UsageScope,
} from "../../types/usage.ts";
import type { BailianClient } from "./client.ts";

// The app-control usage RPCs (`ziel:dashy::bailian-app-control.usage.*`) map to the
// AgentStudio resource paths below (confirmed with the usage contract owner). The
// public AgentStudio deployment has not enabled them yet (404 at the gateway);
// once it does, these calls go through without further changes. If the deployed
// envelope differs from the top-level body, only the unwrapping below needs to change.
const MODEL_USAGE_PATH = "/usage/models";
const TOOL_USAGE_PATH = "/usage/tools";

/**
 * Cross-field request rules from the usage contract, enforced before the call:
 * workspace/agent scopes require an explicit time_range (session scopes reuse the
 * Session's own window and must not send one), workspace scopes must list at least
 * one workspace, and pagination is 1-based with a 1..100 page size.
 */
export function assertUsageRequest(request: ModelUsageRequest | ToolUsageRequest): void {
	const scope: UsageScope = request.scope;
	if (scope.type === "workspace" && !scope.workspace_ids?.length) {
		throw new UserError("Usage scope 'workspace' requires a non-empty workspace_ids list.");
	}
	if (scope.type === "session") {
		if (request.time_range !== undefined) {
			throw new UserError("Usage scope 'session' forbids time_range; the Session's own window is used.");
		}
	} else if (!request.time_range) {
		throw new UserError(`Usage scope '${scope.type}' requires time_range.`);
	}
	if (request.page_no !== undefined && (!Number.isInteger(request.page_no) || request.page_no < 1)) {
		throw new UserError("page_no must be an integer >= 1.");
	}
	if (
		request.page_size !== undefined &&
		(!Number.isInteger(request.page_size) || request.page_size < 1 || request.page_size > 100)
	) {
		throw new UserError("page_size must be an integer between 1 and 100.");
	}
}

/** The endpoint answers with `{ data: UsagePageDTO }`; tolerate a bare page for forward compatibility. */
function unwrapPage<T>(result: unknown): T {
	const page = (result as { data?: T } | null)?.data;
	return (page ?? (result as T)) as T;
}

export async function listBailianModelUsage(
	client: BailianClient,
	request: ModelUsageRequest,
	options: UsageQueryOptions = {},
): Promise<ModelUsagePage> {
	assertUsageRequest(request);
	const result = await client.post(MODEL_USAGE_PATH, request, options.signal ? { signal: options.signal } : undefined);
	return unwrapPage<ModelUsagePage>(result);
}

export async function listBailianToolUsage(
	client: BailianClient,
	request: ToolUsageRequest,
	options: UsageQueryOptions = {},
): Promise<ToolUsagePage> {
	assertUsageRequest(request);
	const result = await client.post(TOOL_USAGE_PATH, request, options.signal ? { signal: options.signal } : undefined);
	return unwrapPage<ToolUsagePage>(result);
}
