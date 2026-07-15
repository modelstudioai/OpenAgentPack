import { UserError } from "../errors.ts";
import type { ProviderAdapter } from "../providers/interface.ts";
import { buildProviders } from "../providers/registry.ts";
import type { StateBackend, StateScope } from "../state/backend.ts";
import type { IStateManager } from "../state/state-manager.ts";
import type { ResolvedProjectConfig } from "../types/config.ts";
// Triggers provider self-registration via side-effect imports in all.ts — must not be removed.
import "../providers/all.ts";

export interface ProjectRuntimeContext {
	configPath?: string;
	statePath?: string;
	projectName: string;
	config: ResolvedProjectConfig;
	state: IStateManager;
	providers: Map<string, ProviderAdapter>;
}

export interface CreateRuntimeInput {
	projectName: string;
	config: ResolvedProjectConfig;
	state: IStateManager;
	configPath?: string;
	providers?: Record<string, unknown>;
}

export interface BackendRuntimeInput {
	projectName: string;
	config: ResolvedProjectConfig;
	stateBackend: StateBackend;
	stateScope: StateScope;
	configPath?: string;
	providers?: Record<string, unknown>;
}

/**
 * Context-first entry point: create a ProjectRuntimeContext from pre-resolved objects.
 * No file I/O is performed — the caller is responsible for loading and resolving config.
 */
export function createProjectRuntime(input: CreateRuntimeInput): ProjectRuntimeContext {
	const providers = buildProviders(input.providers ?? input.config.providers, input.projectName);
	return {
		configPath: input.configPath,
		projectName: input.projectName,
		config: input.config,
		state: input.state,
		providers,
	};
}

export async function readProjectRuntime<T>(
	input: BackendRuntimeInput,
	fn: (ctx: ProjectRuntimeContext) => Promise<T> | T,
): Promise<T> {
	return input.stateBackend.read(input.stateScope, (state) =>
		fn(
			createProjectRuntime({
				projectName: input.projectName,
				config: input.config,
				state,
				configPath: input.configPath,
				providers: input.providers,
			}),
		),
	);
}

export async function writeProjectRuntime<T>(
	input: BackendRuntimeInput,
	fn: (ctx: ProjectRuntimeContext) => Promise<T> | T,
): Promise<T> {
	return input.stateBackend.write(input.stateScope, (state) =>
		fn(
			createProjectRuntime({
				projectName: input.projectName,
				config: input.config,
				state,
				configPath: input.configPath,
				providers: input.providers,
			}),
		),
	);
}

export function getRuntimeProvider(ctx: ProjectRuntimeContext, providerName: string): ProviderAdapter {
	const adapter = ctx.providers.get(providerName);
	if (!adapter) {
		throw new UserError(`Provider '${providerName}' not configured.`);
	}
	return adapter;
}
