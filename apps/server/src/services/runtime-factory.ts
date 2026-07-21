import { type BackendRuntimeInput, type ProjectRuntimeContext, readProjectRuntime } from "@openagentpack/sdk";
import { buildRuntimeConfig } from "@/lib/build-runtime-config";
import { createWebUiStateBackend, deriveWebUiStateScope } from "@/lib/state-scope";
import { type CompiledAgentRuntime, compileAgentRuntime } from "@/services/agents/catalog";

export type ServerRuntimeInput = BackendRuntimeInput & { configPath: string; statePath: string };

export type AgentRuntimeInput = ServerRuntimeInput & {
	agentId: string;
	compiled: CompiledAgentRuntime;
};

/**
 * Base server runtime input: assemble config from env + playbooks, anchor the scoped
 * local-file backend on an explicit statePath, and build the scope. Returns a
 * BackendRuntimeInput that core's scoped entries
 * (readProjectRuntime / writeProjectRuntime) consume directly.
 */
export async function loadServerRuntimeConfig(providerOverride?: string): Promise<ServerRuntimeInput> {
	const { configPath, projectName, config } = await buildRuntimeConfig(providerOverride);
	const stateScope = deriveWebUiStateScope();
	const stateBackend = createWebUiStateBackend();
	const statePath = stateBackend.getStatePath(stateScope);
	return {
		projectName,
		config,
		stateBackend,
		stateScope,
		providers: config.providers,
		configPath,
		statePath,
	};
}

/**
 * Agent-scoped runtime input: resolve config once, compile the agent's config,
 * and keep the scoped backend. Consumed by the *WithStateBackend plan/sync flows.
 * A `modelOverride` recompiles the agent decl with a switched model so a sync applies it.
 */
export async function loadAgentRuntimeInput(
	agentId: string,
	modelOverride?: string,
	providerOverride?: string,
): Promise<AgentRuntimeInput> {
	const base = await loadServerRuntimeConfig(providerOverride);
	const compiled = compileAgentRuntime(agentId, base.config, modelOverride);
	return {
		...base,
		config: compiled.config,
		providers: compiled.config.providers,
		agentId: compiled.agentId,
		compiled,
	};
}

/** Build a runtime input whose config contains a compiled playbook plus caller-owned resources. */
export async function loadCompiledRuntimeInput(agentId: string, provider?: string): Promise<AgentRuntimeInput> {
	return loadAgentRuntimeInput(agentId, undefined, provider);
}

/**
 * Run a function within an agent-scoped runtime context. Reads through the core
 * scoped entry, which hands back a cloned in-memory snapshot.
 */
export async function withAgentRuntime<T>(
	agentId: string,
	fn: (ctx: ProjectRuntimeContext, compiled: CompiledAgentRuntime) => Promise<T> | T,
): Promise<T> {
	const input = await loadAgentRuntimeInput(agentId);
	return readProjectRuntime(input, (ctx) => fn(ctx, input.compiled));
}
