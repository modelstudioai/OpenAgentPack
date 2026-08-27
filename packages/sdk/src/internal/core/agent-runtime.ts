import { UserError } from "../errors.ts";
import { buildDependencyGraph, collectDependencyClosure } from "../graph/dependency.ts";
import type { RemoteResource } from "../providers/interface.ts";
import type { ResourceCrudAdapter } from "../providers/resource-workflow.ts";
import { buildSessionBindings, resolveSessionProvider } from "../session/session-manager.ts";
import type { AgentDecl, AgentSkillDecl, EnvironmentDecl, ProjectConfig, VaultDecl } from "../types/config.ts";
import type {
	AgentDefinition,
	AgentReadiness,
	AgentSkillRef,
	AgentSyncResult,
	AgentSyncRun,
	AgentWithReadiness,
	CloudAgent,
	CloudEnvironment,
	CloudVault,
	Diagnostic,
	PlannedAction,
} from "../types/dto.ts";
import type { ExecutionPlan } from "../types/plan.ts";
import type { ResourceAddress } from "../types/state.ts";
import { addressKey } from "../types/state.ts";
import { resolveAgentMaterialization } from "./agent-materialization.ts";
import type { BackendRuntimeInput, ProjectRuntimeContext } from "./project-runtime.ts";
import { getRuntimeProvider, readProjectRuntime, writeProjectRuntime } from "./project-runtime.ts";
import {
	type DestructivePolicy,
	decideDestructive,
	executePlannedProject,
	planProjectContext,
	type ResourceExecutionResult,
	type ResourcePlanResult,
	replaceResourcePlan,
	selectDestructive,
} from "./resource-runtime.ts";

export type {
	AgentDefinition,
	AgentDriftSeverity,
	AgentReadiness,
	AgentReadinessStatus,
	AgentSkillRef,
	AgentSyncResult,
	AgentSyncRun,
	AgentSyncStatus,
	AgentWithReadiness,
} from "../types/dto.ts";

export interface AgentResourcePlan {
	agentId: string;
	provider: string;
	actions: PlannedAction[];
	diagnostics: Diagnostic[];
	destructiveActions: PlannedAction[];
	planned: ResourcePlanResult;
}

export interface AgentResourcePlanOptions {
	refresh?: boolean;
	quiet?: boolean;
	mode?: AgentResourceSyncMode;
}

export type AgentResourceSyncMode = "reconcile" | "create-only";

export interface AgentResourceSyncOptions extends AgentResourcePlanOptions {
	policy?: DestructivePolicy;
	confirm?: (actions: PlannedAction[]) => boolean | Promise<boolean>;
}

export function listAgents(ctx: ProjectRuntimeContext): AgentDefinition[] {
	const agents = ctx.config.agents ?? {};
	return Object.entries(agents).map(([agentName, agent]) => toAgentDefinition(ctx.config, agentName, agent));
}

/**
 * The cloud-listing seam: enumerate raw remote resources for the resource center.
 * All optional — only providers that can list their remote objects implement them.
 * The wide {@link import("../providers/interface.ts").ProviderAdapter} structurally
 * satisfies it; create/delete of these resources go through {@link ResourceCrudAdapter}.
 */
export interface CloudListAdapter {
	listAgents?(filter?: { prefix?: string; limit?: number }): Promise<CloudAgent[]>;
	listEnvironments?(filter?: { limit?: number }): Promise<CloudEnvironment[]>;
	listVaults?(filter?: { limit?: number }): Promise<CloudVault[]>;
}

/**
 * List RAW cloud agents from the provider — the actual remote objects, not the local
 * config agents that `listAgents` returns. This is what the resource center needs to
 * surface same-name duplicates and identity-stamp drift (metadata.playbook vs agents.*) that
 * the local view can't see. Resolves the single configured provider (or `options.provider`)
 * and delegates to the adapter's optional `listAgents`; returns [] if unsupported.
 */
export async function listCloudAgents(
	ctx: ProjectRuntimeContext,
	options: { provider?: string; prefix?: string; limit?: number } = {},
): Promise<CloudAgent[]> {
	let provider = options.provider;
	if (!provider) {
		const providers = Object.keys(ctx.config.providers ?? {});
		if (providers.length === 1) {
			provider = providers[0]!;
		} else {
			throw new UserError("Multiple providers configured. Pass `provider` to list cloud agents.");
		}
	}
	const adapter: Pick<CloudListAdapter, "listAgents"> = getRuntimeProvider(ctx, provider);
	if (!adapter.listAgents) return [];
	return adapter.listAgents({ prefix: options.prefix, limit: options.limit });
}

/** Resolve the single configured provider, or throw if ambiguous. Shared by the cloud-* helpers. */
function resolveSingleProvider(ctx: ProjectRuntimeContext, provider?: string): string {
	if (provider) return provider;
	const providers = Object.keys(ctx.config.providers ?? {});
	if (providers.length === 1) return providers[0]!;
	throw new UserError("Multiple providers configured. Pass `provider` to target one.");
}

/**
 * List RAW cloud environments — the shared base sandboxes (networking + packages) that
 * sessions run inside. Not tied to any playbook/agent. Delegates to the adapter's optional
 * `listEnvironments`; returns [] if unsupported.
 */
export async function listCloudEnvironments(
	ctx: ProjectRuntimeContext,
	options: { provider?: string; limit?: number } = {},
): Promise<CloudEnvironment[]> {
	const adapter: Pick<CloudListAdapter, "listEnvironments"> = getRuntimeProvider(
		ctx,
		resolveSingleProvider(ctx, options.provider),
	);
	if (!adapter.listEnvironments) return [];
	return adapter.listEnvironments({ limit: options.limit });
}

/** Create a cloud environment directly (used by the webui entry-check base-env provisioning). */
export async function createCloudEnvironment(
	ctx: ProjectRuntimeContext,
	name: string,
	decl: EnvironmentDecl,
	options: { provider?: string } = {},
): Promise<RemoteResource> {
	const adapter: Pick<ResourceCrudAdapter, "createEnvironment"> = getRuntimeProvider(
		ctx,
		resolveSingleProvider(ctx, options.provider),
	);
	return adapter.createEnvironment(name, decl);
}

/** Delete a cloud environment by remote id (used by the webui resource center). */
export async function deleteCloudEnvironment(
	ctx: ProjectRuntimeContext,
	id: string,
	options: { provider?: string } = {},
): Promise<void> {
	const adapter: Pick<ResourceCrudAdapter, "deleteEnvironment"> = getRuntimeProvider(
		ctx,
		resolveSingleProvider(ctx, options.provider),
	);
	await adapter.deleteEnvironment(id);
}

/**
 * List RAW cloud vaults — the shared credential stores bound to sessions via `vault_ids`.
 * Not tied to any playbook/agent. Delegates to the adapter's optional `listVaults`; returns []
 * if unsupported.
 */
export async function listCloudVaults(
	ctx: ProjectRuntimeContext,
	options: { provider?: string; limit?: number } = {},
): Promise<CloudVault[]> {
	const adapter: Pick<CloudListAdapter, "listVaults"> = getRuntimeProvider(
		ctx,
		resolveSingleProvider(ctx, options.provider),
	);
	if (!adapter.listVaults) return [];
	return adapter.listVaults({ limit: options.limit });
}

/** Create a cloud vault (+ its credentials) directly, for the webui's user-supplied-key flow. */
export async function createCloudVault(
	ctx: ProjectRuntimeContext,
	name: string,
	decl: VaultDecl,
	options: { provider?: string } = {},
): Promise<RemoteResource> {
	const adapter: Pick<ResourceCrudAdapter, "createVault"> = getRuntimeProvider(
		ctx,
		resolveSingleProvider(ctx, options.provider),
	);
	return adapter.createVault(name, decl);
}

/** Delete a cloud vault by remote id (used by the webui resource center). */
export async function deleteCloudVault(
	ctx: ProjectRuntimeContext,
	id: string,
	options: { provider?: string } = {},
): Promise<void> {
	const adapter: Pick<ResourceCrudAdapter, "deleteVault"> = getRuntimeProvider(
		ctx,
		resolveSingleProvider(ctx, options.provider),
	);
	await adapter.deleteVault(id);
}

/** Archive a cloud agent (soft delete → status=archived). Used by the resource center's
 * archive action; the bailian adapter maps this to POST /agents/{id}/archive. */
export async function archiveCloudAgent(
	ctx: ProjectRuntimeContext,
	id: string,
	options: { provider?: string } = {},
): Promise<void> {
	const adapter: Pick<ResourceCrudAdapter, "deleteAgent"> = getRuntimeProvider(
		ctx,
		resolveSingleProvider(ctx, options.provider),
	);
	await adapter.deleteAgent(id);
}

export function getAgent(ctx: ProjectRuntimeContext, agentId: string): AgentDefinition {
	const agent = ctx.config.agents?.[agentId];
	if (!agent) {
		throw new UserError(`Agent '${agentId}' not found in config.`);
	}
	return toAgentDefinition(ctx.config, agentId, agent);
}

export async function listAgentsWithReadiness(
	ctx: ProjectRuntimeContext,
	options: { refresh?: boolean } = {},
): Promise<AgentWithReadiness[]> {
	const planResult = await planProjectContext(ctx, { refresh: options.refresh });
	return listAgents(ctx).map((agent) => ({
		agent,
		readiness: getAgentReadinessFromPlan(ctx, agent.id, planResult.plan),
	}));
}

// An agent can run if it is ready, or drifted only in a non-blocking way.
export function isAgentRunnable(readiness: AgentReadiness): boolean {
	return readiness.status === "ready" || (readiness.status === "drifted" && readiness.driftSeverity === "non_blocking");
}

export async function planAgentResources(
	ctx: ProjectRuntimeContext,
	agentId: string,
	options: AgentResourcePlanOptions = {},
): Promise<AgentResourcePlan> {
	const agent = getAgent(ctx, agentId);
	const rootAddress = collectAgentAddresses(ctx.config, agent.agentName, agent.provider)[0]!;
	let planned = await planProjectContext(ctx, {
		provider: agent.provider,
		scope: { roots: [rootAddress] },
		refresh: options.refresh,
		quiet: options.quiet ?? true,
	});
	const actions = planned.plan.actions;
	let diagnostics = planned.plan.diagnostics;
	if (options.mode === "create-only") {
		const blockedReason = getCreateOnlyBlockedReason(planned, rootAddress);
		if (blockedReason) {
			diagnostics = [
				...diagnostics,
				{
					severity: "error",
					code: "agent.create_only.blocked",
					message: blockedReason,
					resource: rootAddress,
				},
			];
			planned = replaceResourcePlan(planned, { ...planned.plan, diagnostics });
		}
	}
	return {
		agentId,
		provider: agent.provider,
		actions,
		diagnostics,
		destructiveActions: selectDestructive(actions),
		planned,
	};
}

export async function planAgentResourcesWithStateBackend(
	input: BackendRuntimeInput,
	agentId: string,
	options: AgentResourcePlanOptions = {},
): Promise<AgentResourcePlan> {
	return readProjectRuntime(input, (ctx) => planAgentResources(ctx, agentId, options));
}

export async function syncAgentResources(
	ctx: ProjectRuntimeContext,
	agentId: string,
	options: AgentResourceSyncOptions = {},
): Promise<AgentSyncRun> {
	return runAgentSync(ctx, agentId, options);
}

async function runAgentSync(
	ctx: ProjectRuntimeContext,
	agentId: string,
	options: AgentResourceSyncOptions,
): Promise<AgentSyncRun> {
	const fullPlan = await planAgentResources(ctx, agentId, {
		refresh: options.refresh,
		quiet: options.quiet,
		mode: options.mode,
	});
	const actions = fullPlan.actions;
	const destructiveActions = fullPlan.destructiveActions;
	const errorDiagnostic = fullPlan.diagnostics.find((diagnostic) => diagnostic.severity === "error");

	const decision = await decideDestructive(destructiveActions, {
		policy: options.policy,
		confirm: options.confirm,
	});
	if (decision !== "proceed") {
		return {
			agentId,
			provider: fullPlan.provider,
			status: "blocked",
			actions,
			diagnostics: fullPlan.diagnostics,
			destructiveActions,
			results: [],
			error:
				decision === "cancelled"
					? "Destructive actions were declined. No remote resources were changed."
					: "Current plan contains destructive actions. Agent sync will not delete remote resources.",
		};
	}

	if (errorDiagnostic) {
		return {
			agentId,
			provider: fullPlan.provider,
			status: "blocked",
			actions,
			diagnostics: fullPlan.diagnostics,
			destructiveActions,
			results: [],
			error: errorDiagnostic.message,
		};
	}

	try {
		const execution = await executePlannedProject(fullPlan.planned, {
			policy: "force",
		});
		const results = toAgentSyncResults(execution);
		const failed = results.find((result) => result.status === "failed");

		return {
			agentId,
			provider: fullPlan.provider,
			status: failed ? "failed" : "completed",
			actions,
			diagnostics: fullPlan.diagnostics,
			destructiveActions,
			results,
			error: failed?.error,
		};
	} catch (error) {
		return {
			agentId,
			provider: fullPlan.provider,
			status: "failed",
			actions,
			diagnostics: fullPlan.diagnostics,
			destructiveActions,
			results: [],
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

export async function syncAgentResourcesWithStateBackend(
	input: BackendRuntimeInput,
	agentId: string,
	options: AgentResourceSyncOptions = {},
): Promise<AgentSyncRun> {
	return writeProjectRuntime(input, (ctx) => syncAgentResources(ctx, agentId, options));
}

function getCreateOnlyBlockedReason(planned: ResourcePlanResult, rootAddress: ResourceAddress): string | undefined {
	const refreshError = planned.refreshResult?.errors[0];
	if (refreshError) {
		return `Cannot verify Agent dependencies because refresh failed for ${addressKey(refreshError.resource.address)}: ${refreshError.error}`;
	}

	const rootKey = addressKey(rootAddress);
	const rootAction = planned.plan.actions.find((action) => addressKey(action.address) === rootKey);
	if (!rootAction) return `Scoped plan did not contain the target Agent ${rootKey}.`;
	if (rootAction.action !== "create") {
		return `Target Agent ${rootKey} must be a new resource, but the scoped plan requires '${rootAction.action}'.`;
	}

	const dependencyChanges = planned.plan.actions.filter(
		(action) => addressKey(action.address) !== rootKey && action.action !== "no-op",
	);
	if (dependencyChanges.length > 0) {
		const labels = dependencyChanges.map((action) => `${addressKey(action.address)} (${action.action})`).join(", ");
		return `Agent create requires every declared dependency to be up-to-date. Reconcile these resources first: ${labels}.`;
	}
	return undefined;
}

export function toAgentSyncResults(execution: ResourceExecutionResult): AgentSyncResult[] {
	return execution.results.map((result) => ({
		action: result.action,
		status: result.status,
		error: result.error,
	}));
}

export function getAgentReadinessFromPlan(
	ctx: ProjectRuntimeContext,
	agentId: string,
	plan: ExecutionPlan,
): AgentReadiness {
	const agent = getAgent(ctx, agentId);
	const relevantKeys = new Set(collectAgentAddresses(ctx.config, agent.agentName, agent.provider).map(addressKey));
	const relevantActions = plan.actions.filter((action) => relevantKeys.has(addressKey(action.address)));
	const diagnostics = plan.diagnostics.filter(
		(diagnostic) => !diagnostic.resource || relevantKeys.has(addressKey(diagnostic.resource)),
	);
	const missing = relevantActions.filter((action) => action.action === "create").map((action) => action.address);

	if (diagnostics.some((d) => d.severity === "error")) {
		return {
			status: "invalid",
			agentId,
			diagnostics,
			missing,
			plannedActions: relevantActions,
		};
	}

	try {
		buildSessionBindings(agent.agentName, ctx.config, agent.provider, ctx.state, {});
	} catch (err) {
		if (missing.length > 0) {
			return {
				status: "missing",
				agentId,
				diagnostics,
				missing,
				plannedActions: relevantActions,
			};
		}
		const message = err instanceof Error ? err.message : String(err);
		return {
			status: "invalid",
			agentId,
			diagnostics: [...diagnostics, { severity: "error", code: "agent.invalid", message }],
			missing,
			plannedActions: relevantActions,
		};
	}

	if (missing.length > 0) {
		return {
			status: "missing",
			agentId,
			diagnostics,
			missing,
			plannedActions: relevantActions,
		};
	}

	const changedActions = relevantActions.filter((action) => action.action !== "no-op");
	if (changedActions.length > 0) {
		return {
			status: "drifted",
			agentId,
			driftSeverity: changedActions.every(isNonBlockingAgentDrift) ? "non_blocking" : "blocking",
			diagnostics,
			missing,
			plannedActions: relevantActions,
		};
	}

	return {
		status: "ready",
		agentId,
		diagnostics,
		missing,
		plannedActions: relevantActions,
	};
}

function isNonBlockingAgentDrift(action: PlannedAction): boolean {
	if (action.action === "no-op") return true;
	return action.readinessImpact === "non_blocking";
}

export function collectAgentAddresses(config: ProjectConfig, agentName: string, provider?: string): ResourceAddress[] {
	const agent = config.agents?.[agentName];
	if (!agent) {
		throw new UserError(`Agent '${agentName}' not found in config.`);
	}
	const resolvedProvider = provider ?? resolveSessionProvider(agentName, config, undefined);
	const materialization = resolveAgentMaterialization(resolvedProvider, agent);
	const rootAddress: ResourceAddress = {
		type: materialization.resourceType,
		name: agentName,
		provider: resolvedProvider,
	};
	const graph = buildDependencyGraph(config, [resolvedProvider]);
	return collectDependencyClosure(graph, [rootAddress]);
}

function toAgentDefinition(config: ProjectConfig, agentName: string, agent: AgentDecl): AgentDefinition {
	return {
		id: agentName,
		agentName,
		provider: resolveSessionProvider(agentName, config, undefined),
		description: agent.description,
		model: agent.model,
		environment: agent.environment,
		tools: agent.tools,
		skills: (agent.skills ?? []).map(toAgentSkillRef),
		mcpServers: (agent.mcp_servers ?? []).map((server) => server.name),
		metadata: agent.metadata,
	};
}

function toAgentSkillRef(skill: AgentSkillDecl): AgentSkillRef {
	if (typeof skill === "string") {
		return { type: "custom", id: skill };
	}
	return {
		type: skill.type,
		id: skill.skill_id,
		version: skill.version,
	};
}
