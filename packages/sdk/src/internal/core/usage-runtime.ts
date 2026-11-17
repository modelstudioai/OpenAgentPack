import type {
	UsageQueryOptions,
	UsageSummaryRequest,
	UsageSummaryResponse,
	UsageTrendRequest,
	UsageTrendResponse,
} from "../types/usage.ts";
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

/**
 * Bucketed usage trend (app-control usage.trend) for `workspace`/`agent`.
 * Each page carries the same `total/models/tools` views plus a `next_page_token`
 * cursor; callers follow the cursor instead of assuming a fixed page count.
 */
export async function getUsageTrend(
	ctx: ManagedApiContext,
	request: UsageTrendRequest,
	options: UsageRuntimeOptions = {},
): Promise<UsageTrendResponse> {
	const adapter = resolveManagedApiAdapter(ctx, options.provider);
	const method = requireManagedApiMethod(adapter.getUsageTrend, adapter.name, "usage trend");
	return method.call(adapter, request, { signal: options.signal });
}
