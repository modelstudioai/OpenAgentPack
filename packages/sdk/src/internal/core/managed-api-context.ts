import { UserError } from "../errors.ts";
import type { ProviderAdapter } from "../providers/interface.ts";
import { buildProviders } from "../providers/registry.ts";
import type { ProjectRuntimeContext } from "./project-runtime.ts";
// The lightweight context also works without loading a project runtime first.
import "../providers/all.ts";

/** Provider-only context for workspace APIs; contains no project config or state. */
export type ManagedApiContext = Pick<ProjectRuntimeContext, "providers">;

export interface CreateManagedApiContextInput {
	/** Already-resolved provider configuration; credentials are supplied by the host. */
	providers: Record<string, unknown>;
}

/** Validate provider configuration and create adapters without file or network I/O. */
export function createManagedApiContext(input: CreateManagedApiContextInput): ManagedApiContext {
	return { providers: buildProviders(input.providers) };
}

export function resolveManagedApiAdapter(ctx: ManagedApiContext, provider?: string): ProviderAdapter {
	if (provider) {
		const adapter = ctx.providers.get(provider);
		if (!adapter) throw new UserError(`Provider '${provider}' not configured.`);
		return adapter;
	}
	if (ctx.providers.size === 0) throw new UserError("No providers configured.");
	if (ctx.providers.size === 1) return ctx.providers.values().next().value!;
	throw new UserError("Multiple providers configured. Use --provider to specify one.");
}

export function requireManagedApiMethod<Method>(
	value: Method | undefined,
	provider: string,
	operation: string,
): Method {
	if (value) return value;
	throw new UserError(`Provider '${provider}' does not support ${operation}.`);
}
