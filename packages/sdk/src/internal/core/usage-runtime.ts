import type { UsageQueryOptions, UsageSummaryRequest, UsageSummaryResponse } from "../types/usage.ts";
import { type ManagedApiContext, requireManagedApiMethod, resolveManagedApiAdapter } from "./managed-api-context.ts";

export interface UsageRuntimeOptions extends UsageQueryOptions {
	/** Explicit provider; required when more than one provider is configured. */
	provider?: string;
}

/**
 * Aggregated usage for one dimension (app-control usage.summary). Model and tool
 * details are returned by the same call, so callers render both tables from one
 * response instead of issuing per-table requests.
 */
export async function getUsageSummary(
	ctx: ManagedApiContext,
	request: UsageSummaryRequest,
	options: UsageRuntimeOptions = {},
): Promise<UsageSummaryResponse> {
	const adapter = resolveManagedApiAdapter(ctx, options.provider);
	const method = requireManagedApiMethod(adapter.getUsageSummary, adapter.name, "usage summary");
	return method.call(adapter, request, { signal: options.signal });
}
