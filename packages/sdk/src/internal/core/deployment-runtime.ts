import { UserError } from "../errors.ts";
import { resolveDeploymentRefs } from "../executor/resolver.ts";
import type {
	DeploymentContext,
	DeploymentListFilter,
	DeploymentListResult,
	DeploymentInfo as ProviderDeploymentInfo,
} from "../providers/interface.ts";
import type { DeploymentRunAdapter } from "../providers/resource-workflow.ts";
import type { ProjectConfig } from "../types/config.ts";
import type { ResourceState } from "../types/state.ts";
import type { ProjectRuntimeContext } from "./project-runtime.ts";
import { getRuntimeProvider } from "./project-runtime.ts";
import "../providers/all.ts";

export interface DeploymentSummary {
	name: string;
	provider: string;
	remoteId: string | null;
	scheduleExpression: string;
	agent: string;
	state: ResourceState;
}

export interface DeploymentBindings {
	agentId: string;
	environmentId: string;
	vaultIds: string[];
	memoryStoreIds: string[];
}

export interface DeploymentInfo {
	id: string | null;
	status: string;
	paused_reason?: { type: string; error?: { type: string } };
	schedule?: { expression: string; timezone?: string };
	attributes?: Record<string, unknown>;
}

export interface DeploymentDetail {
	name: string;
	provider: string;
	info: DeploymentInfo;
	bindings: DeploymentBindings;
}

export interface DeploymentRunResult {
	run_id?: string;
	session_id: string | null;
	error?: { type: string; message: string };
}

export interface DeploymentRun {
	name: string;
	provider: string;
	result: DeploymentRunResult;
}

export async function listRemoteDeploymentsForContext(
	ctx: ProjectRuntimeContext,
	provider: string,
	filter?: DeploymentListFilter,
): Promise<DeploymentListResult> {
	const adapter = getRuntimeProvider(ctx, provider);
	if (!adapter.listDeployments)
		throw new UserError(`Provider '${provider}' does not support remote deployment listing.`);
	return adapter.listDeployments(filter);
}

export function listDeploymentsForContext(ctx: ProjectRuntimeContext, providerFilter?: string): DeploymentSummary[] {
	let rows = ctx.state.listResources().filter((resource) => resource.address.type === "deployment");
	if (providerFilter) {
		rows = rows.filter((resource) => resource.address.provider === providerFilter);
	}

	return rows.map((resource) => {
		const name = resource.address.name;
		const deployment = ctx.config.deployments?.[name];
		return {
			name,
			provider: resource.address.provider,
			remoteId: resource.remote_id,
			scheduleExpression: deployment?.schedule?.expression ?? "manual",
			agent: deployment?.agent ?? "?",
			state: resource,
		};
	});
}

export async function getDeploymentDetailsForContext(
	ctx: ProjectRuntimeContext,
	name: string,
	adapter?: Pick<DeploymentRunAdapter, "getDeployment">,
	resolvedProvider?: string,
): Promise<DeploymentDetail> {
	const provider = resolvedProvider ?? resolveDeploymentProvider(name, ctx.config);
	const effectiveAdapter = adapter ?? getRuntimeProvider(ctx, provider);
	const depCtx = buildDeploymentContext(ctx, name, provider);
	return {
		name,
		provider,
		bindings: {
			agentId: depCtx.refs.agent_id,
			environmentId: depCtx.refs.environment_id,
			vaultIds: depCtx.refs.vault_ids,
			memoryStoreIds: Object.values(depCtx.refs.memory_store_ids),
		},
		info: await effectiveAdapter.getDeployment(depCtx),
	};
}

export async function runDeploymentForContext(
	ctx: ProjectRuntimeContext,
	name: string,
	adapter?: Pick<DeploymentRunAdapter, "runDeployment">,
	resolvedProvider?: string,
): Promise<DeploymentRun> {
	const provider = resolvedProvider ?? resolveDeploymentProvider(name, ctx.config);
	const effectiveAdapter = adapter ?? getRuntimeProvider(ctx, provider);
	const depCtx = buildDeploymentContext(ctx, name, provider);
	return {
		name,
		provider,
		result: await effectiveAdapter.runDeployment(depCtx),
	};
}

export async function pauseDeploymentForContext(
	ctx: ProjectRuntimeContext,
	name: string,
	paused: boolean,
	resolvedProvider?: string,
): Promise<ProviderDeploymentInfo> {
	const provider = resolvedProvider ?? resolveDeploymentProvider(name, ctx.config);
	const adapter = getRuntimeProvider(ctx, provider);
	const operation = paused ? adapter.pauseDeployment : adapter.unpauseDeployment;
	if (!operation)
		throw new UserError(`Provider '${provider}' does not support ${paused ? "pausing" : "unpausing"} deployments.`);
	return operation.call(adapter, buildDeploymentContext(ctx, name, provider));
}

export function getDeploymentRuntimeProviderForContext(
	ctx: ProjectRuntimeContext,
	name: string,
	overrideProvider?: string,
): string {
	return resolveDeploymentProvider(name, ctx.config, overrideProvider);
}

export function resolveDeploymentProvider(name: string, config: ProjectConfig, overrideProvider?: string): string {
	const dep = config.deployments?.[name];
	if (!dep) {
		const available = Object.keys(config.deployments ?? {}).join(", ");
		throw new UserError(`Deployment '${name}' not found in config. Available: ${available || "(none)"}`);
	}
	if (overrideProvider) return overrideProvider;
	if (dep.provider) return dep.provider;

	const agent = config.agents?.[dep.agent];
	if (agent?.provider) return agent.provider;

	const def = config.defaults?.provider;
	if (def && def !== "all") return def;

	const providers = Object.keys(config.providers);
	if (providers.length === 1) return providers[0]!;

	throw new UserError(`Deployment '${name}' could not resolve a single provider. Use --provider to specify one.`);
}

function buildDeploymentContext(ctx: ProjectRuntimeContext, name: string, provider: string): DeploymentContext {
	const dep = ctx.config.deployments?.[name];
	if (!dep) {
		const available = Object.keys(ctx.config.deployments ?? {}).join(", ");
		throw new UserError(`Deployment '${name}' not found in config. Available: ${available || "(none)"}`);
	}
	const refs = resolveDeploymentRefs(name, ctx.config, provider, ctx.state);
	const depState = ctx.state.getResource({ type: "deployment", name, provider });
	return {
		id: depState?.remote_id ?? null,
		name,
		decl: dep,
		refs,
		basePath: ctx.configPath ?? "",
	};
}
