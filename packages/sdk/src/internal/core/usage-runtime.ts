import type {
	ModelUsagePage,
	ModelUsageRequest,
	ToolUsagePage,
	ToolUsageRequest,
	UsageQueryOptions,
} from "../types/usage.ts";
import { type ManagedApiContext, requireManagedApiMethod, resolveManagedApiAdapter } from "./managed-api-context.ts";

export interface UsageRuntimeOptions extends UsageQueryOptions {
	/** Explicit provider; required when more than one provider is configured. */
	provider?: string;
}

/** Aggregated model usage (calls, failures, token breakdowns) for a workspace/agent/session scope. */
export async function listModelUsage(
	ctx: ManagedApiContext,
	request: ModelUsageRequest,
	options: UsageRuntimeOptions = {},
): Promise<ModelUsagePage> {
	const adapter = resolveManagedApiAdapter(ctx, options.provider);
	const method = requireManagedApiMethod(adapter.listModelUsage, adapter.name, "model usage listing");
	return method.call(adapter, request, { signal: options.signal });
}

/** Aggregated tool usage (calls, failures by tool source) for a workspace/agent/session scope. */
export async function listToolUsage(
	ctx: ManagedApiContext,
	request: ToolUsageRequest,
	options: UsageRuntimeOptions = {},
): Promise<ToolUsagePage> {
	const adapter = resolveManagedApiAdapter(ctx, options.provider);
	const method = requireManagedApiMethod(adapter.listToolUsage, adapter.name, "tool usage listing");
	return method.call(adapter, request, { signal: options.signal });
}
