import { UserError } from "../errors.ts";
import { ApiError } from "../providers/base-client.ts";
import type { ProviderAdapter } from "../providers/interface.ts";
import type { RuntimeFeedbackSink } from "../types/runtime-feedback.ts";
import { emitRuntimeFeedback } from "../types/runtime-feedback.ts";
import type { ResourceState, ResourceType } from "../types/state.ts";
import type { ProjectRuntimeContext } from "./project-runtime.ts";
import { getRuntimeProvider } from "./project-runtime.ts";

export type DestroyResourceStatus = "success" | "failed" | "blocked" | "skipped";

export type DestroyResourceResultReason =
	| "destroyed"
	| "reference_removed"
	| "already_gone"
	| "cascade_required"
	| "provider_missing"
	| "failed"
	| "skipped";

export interface DestroyResourceResult {
	resource: ResourceState;
	status: DestroyResourceStatus;
	reason: DestroyResourceResultReason;
	error?: string;
	cascaded?: boolean;
}

export interface DestroyPlanResult {
	resources: ResourceState[];
	defaultMemoryStores: DestroyDefaultMemoryStorePlan[];
	executionContext: ProjectRuntimeContext;
}

export interface DestroyDefaultMemoryStorePlan {
	agentName: string;
	provider: string;
	identityId: string | null;
	templateId: string | null;
	deleteOnDestroy: boolean;
	memoryStoreId?: string;
}

export interface DestroyDefaultMemoryStoreResult extends DestroyDefaultMemoryStorePlan {
	status: "retained" | "deleted" | "already_gone" | "failed";
	memoryStoreId?: string;
	error?: string;
}

export interface DestroyProjectOptions {
	cascade?: boolean;
	onFeedback?: RuntimeFeedbackSink;
	onResourceStart?: (resource: ResourceState) => void;
	onResourceResult?: (result: DestroyResourceResult) => void;
	onCascadeRequired?: (result: DestroyResourceResult) => boolean | Promise<boolean>;
	/** Override bounded cleanup backoff, primarily for deterministic tests. */
	defaultMemoryStoreRetryDelaysMs?: number[];
}

export interface DestroyProjectResult extends DestroyPlanResult {
	results: DestroyResourceResult[];
	defaultMemoryStoreResults: DestroyDefaultMemoryStoreResult[];
	destroyed: number;
	partial: boolean;
}

const destroyOrder: Record<ResourceType, number> = {
	deployment: 0,
	channel: 0,
	agent: 1,
	template: 1,
	identity: 2,
	skill: 3,
	memory_store: 4,
	vault: 5,
	file: 6,
	environment: 7,
};

export function planDestroyProjectContext(ctx: ProjectRuntimeContext): DestroyPlanResult {
	const resources = [...ctx.state.listResources()].sort(
		(a, b) => (destroyOrder[a.address.type] ?? 99) - (destroyOrder[b.address.type] ?? 99),
	);
	const identityName = ctx.config.defaults?.identity;
	const defaultMemoryStores: DestroyDefaultMemoryStorePlan[] = [];
	for (const [agentName, agent] of Object.entries(ctx.config.agents ?? {})) {
		if (!agent.default_memory_store || agent.delivery?.qoder?.type !== "forward") continue;
		if (agent.provider && agent.provider !== "qoder") continue;
		defaultMemoryStores.push({
			agentName,
			provider: "qoder",
			identityId: identityName
				? (ctx.state.getResource({ type: "identity", name: identityName, provider: "qoder" })?.remote_id ?? null)
				: null,
			templateId: ctx.state.getResource({ type: "template", name: agentName, provider: "qoder" })?.remote_id ?? null,
			deleteOnDestroy: agent.default_memory_store.delete_on_destroy ?? false,
		});
	}
	for (const pending of ctx.state.getStateFile().pending_default_memory_store_cleanups ?? []) {
		const existing = defaultMemoryStores.find(
			(item) => item.agentName === pending.agent_name && item.provider === pending.provider,
		);
		if (existing) {
			existing.memoryStoreId = pending.remote_id;
			existing.deleteOnDestroy = true;
		} else {
			defaultMemoryStores.push({
				agentName: pending.agent_name,
				provider: pending.provider,
				identityId: pending.identity_id ?? null,
				templateId: pending.template_id ?? null,
				deleteOnDestroy: true,
				memoryStoreId: pending.remote_id,
			});
		}
	}
	return { resources, defaultMemoryStores, executionContext: ctx };
}

export async function destroyPlannedProjectResources(
	planned: DestroyPlanResult,
	options: DestroyProjectOptions = {},
): Promise<DestroyProjectResult> {
	const results: DestroyResourceResult[] = [];
	const capturedDefaults = await captureDefaultMemoryStores(planned);
	const ctx = planned.executionContext;
	if (capturedDefaults.some((item) => item.error)) {
		const defaultMemoryStoreResults = capturedDefaults.map(preflightFailureResult);
		for (const resource of planned.resources) {
			const result: DestroyResourceResult = {
				resource,
				status: "blocked",
				reason: "skipped",
				error: "Destroy aborted because the default Memory Store preflight failed.",
			};
			results.push(result);
			options.onResourceResult?.(result);
		}
		return { ...planned, results, defaultMemoryStoreResults, destroyed: 0, partial: true };
	}
	if (await persistCapturedDefaultMemoryStores(ctx, capturedDefaults)) {
		await ctx.state.save();
	}

	let stateChanged = false;

	for (const resource of planned.resources) {
		options.onResourceStart?.(resource);
		const result = await destroyOneResource(ctx, resource, options);
		results.push(result);
		options.onResourceResult?.(result);
		if (result.status === "success") stateChanged = true;
	}

	if (stateChanged) {
		await ctx.state.save();
	}
	const defaultMemoryStoreResults = await finalizeDefaultMemoryStores(planned, capturedDefaults, options);
	if (recordFailedDefaultMemoryStoreCleanups(ctx, defaultMemoryStoreResults)) {
		await ctx.state.save();
	}
	if (clearCompletedDefaultMemoryStoreCleanups(ctx, defaultMemoryStoreResults)) {
		await ctx.state.save();
	}

	const destroyed = results.filter((result) => result.status === "success").length;
	return {
		...planned,
		results,
		defaultMemoryStoreResults,
		destroyed,
		partial:
			destroyed !== planned.resources.length || defaultMemoryStoreResults.some((result) => result.status === "failed"),
	};
}

interface CapturedDefaultMemoryStore {
	plan: DestroyDefaultMemoryStorePlan;
	memoryStoreId?: string;
	error?: string;
}

async function persistCapturedDefaultMemoryStores(
	ctx: ProjectRuntimeContext,
	captured: CapturedDefaultMemoryStore[],
): Promise<boolean> {
	const state = ctx.state.getStateFile();
	if (!state.pending_default_memory_store_cleanups) state.pending_default_memory_store_cleanups = [];
	const pending = state.pending_default_memory_store_cleanups;
	let changed = false;
	for (const item of captured) {
		if (!item.plan.deleteOnDestroy || !item.memoryStoreId) continue;
		if (pending.some((entry) => entry.provider === item.plan.provider && entry.remote_id === item.memoryStoreId))
			continue;
		pending.push({
			agent_name: item.plan.agentName,
			provider: item.plan.provider,
			remote_id: item.memoryStoreId,
			...(item.plan.identityId ? { identity_id: item.plan.identityId } : {}),
			...(item.plan.templateId ? { template_id: item.plan.templateId } : {}),
		});
		changed = true;
	}
	return changed;
}

function clearCompletedDefaultMemoryStoreCleanups(
	ctx: ProjectRuntimeContext,
	results: DestroyDefaultMemoryStoreResult[],
): boolean {
	const state = ctx.state.getStateFile();
	const completedIds = new Set(
		results
			.filter((item) => item.status === "deleted" || item.status === "already_gone")
			.map((item) => item.memoryStoreId)
			.filter((id): id is string => Boolean(id)),
	);
	if (completedIds.size === 0 || !state.pending_default_memory_store_cleanups?.length) return false;
	const remaining = state.pending_default_memory_store_cleanups.filter((item) => !completedIds.has(item.remote_id));
	if (remaining.length === state.pending_default_memory_store_cleanups.length) return false;
	state.pending_default_memory_store_cleanups = remaining;
	return true;
}

function recordFailedDefaultMemoryStoreCleanups(
	ctx: ProjectRuntimeContext,
	results: DestroyDefaultMemoryStoreResult[],
): boolean {
	const pending = ctx.state.getStateFile().pending_default_memory_store_cleanups;
	if (!pending?.length) return false;
	let changed = false;
	for (const result of results) {
		if (result.status !== "failed" || !result.memoryStoreId) continue;
		const entry = pending.find((item) => item.remote_id === result.memoryStoreId);
		if (entry && entry.last_error !== result.error) {
			entry.last_error = result.error;
			changed = true;
		}
	}
	return changed;
}

function preflightFailureResult(item: CapturedDefaultMemoryStore): DestroyDefaultMemoryStoreResult {
	if (!item.plan.deleteOnDestroy) return { ...item.plan, status: "retained" };
	return {
		...item.plan,
		status: "failed",
		...(item.memoryStoreId ? { memoryStoreId: item.memoryStoreId } : {}),
		error: item.error ?? "Destroy aborted because another default Memory Store preflight failed.",
	};
}

async function captureDefaultMemoryStores(planned: DestroyPlanResult): Promise<CapturedDefaultMemoryStore[]> {
	return Promise.all(
		planned.defaultMemoryStores.map(async (item) => {
			if (!item.deleteOnDestroy) return { plan: item };
			if (item.memoryStoreId) return { plan: item, memoryStoreId: item.memoryStoreId };
			if (!item.identityId || !item.templateId) {
				return { plan: item, error: "Cannot resolve the Identity and Template before destroy." };
			}
			try {
				const provider = getRuntimeProvider(planned.executionContext, item.provider);
				if (!provider.findDefaultMemoryStoreId || !provider.deleteDefaultMemoryStore) {
					return { plan: item, error: `Provider '${item.provider}' cannot delete a default memory store.` };
				}
				const memoryStoreId = await provider.findDefaultMemoryStoreId(item.identityId, item.templateId);
				return { plan: item, ...(memoryStoreId ? { memoryStoreId } : {}) };
			} catch (error) {
				return { plan: item, error: error instanceof Error ? error.message : String(error) };
			}
		}),
	);
}

async function finalizeDefaultMemoryStores(
	planned: DestroyPlanResult,
	captured: CapturedDefaultMemoryStore[],
	options: DestroyProjectOptions,
): Promise<DestroyDefaultMemoryStoreResult[]> {
	const output: DestroyDefaultMemoryStoreResult[] = [];
	for (const item of captured) {
		if (!item.plan.deleteOnDestroy) {
			output.push({ ...item.plan, status: "retained" });
			continue;
		}
		if (item.error) {
			output.push({ ...item.plan, status: "failed", error: item.error });
			continue;
		}
		if (!item.memoryStoreId) {
			output.push({ ...item.plan, status: "already_gone" });
			continue;
		}
		try {
			const provider = getRuntimeProvider(planned.executionContext, item.plan.provider);
			await deleteDefaultMemoryStoreWithArchiveFallback(
				provider,
				item.memoryStoreId,
				options.defaultMemoryStoreRetryDelaysMs ?? [1000, 2000, 4000, 8000],
			);
			output.push({ ...item.plan, status: "deleted", memoryStoreId: item.memoryStoreId });
		} catch (error) {
			if (ApiError.isNotFound(error)) {
				output.push({ ...item.plan, status: "already_gone", memoryStoreId: item.memoryStoreId });
			} else {
				output.push({
					...item.plan,
					status: "failed",
					memoryStoreId: item.memoryStoreId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}
	return output;
}

async function deleteDefaultMemoryStoreWithArchiveFallback(
	provider: ProviderAdapter,
	memoryStoreId: string,
	retryDelaysMs: number[],
): Promise<void> {
	try {
		await retryDefaultMemoryStoreOperation(() => provider.deleteDefaultMemoryStore!(memoryStoreId), retryDelaysMs);
	} catch (error) {
		if (isAlreadyArchivedConflict(error) && provider.deleteMemoryStore) {
			await retryDefaultMemoryStoreOperation(() => provider.deleteMemoryStore!(memoryStoreId), retryDelaysMs);
			return;
		}
		if (!isStillMountedConflict(error) || !provider.archiveMemoryStore || !provider.deleteMemoryStore) throw error;
		await retryDefaultMemoryStoreOperation(() => provider.archiveMemoryStore!(memoryStoreId), retryDelaysMs);
		await retryDefaultMemoryStoreOperation(() => provider.deleteMemoryStore!(memoryStoreId), retryDelaysMs);
	}
}

async function retryDefaultMemoryStoreOperation(operation: () => Promise<unknown>, delaysMs: number[]): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			await operation();
			return;
		} catch (error) {
			if (!isRetryableDefaultMemoryStoreError(error) || attempt >= delaysMs.length) throw error;
			await delay(delaysMs[attempt]!);
		}
	}
}

function isRetryableDefaultMemoryStoreError(error: unknown): boolean {
	return (
		error instanceof ApiError &&
		(isStillMountedConflict(error) ||
			isAlreadyArchivedConflict(error) ||
			error.statusCode === 429 ||
			[500, 502, 503].includes(error.statusCode))
	);
}

function isStillMountedConflict(error: unknown): boolean {
	return error instanceof ApiError && error.statusCode === 409 && error.responseBody.includes("still mounted");
}

function isAlreadyArchivedConflict(error: unknown): boolean {
	return (
		error instanceof ApiError &&
		error.statusCode === 409 &&
		error.responseBody.toLowerCase().includes("already archived")
	);
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function destroyOneResource(
	ctx: ProjectRuntimeContext,
	resource: ResourceState,
	options: DestroyProjectOptions,
): Promise<DestroyResourceResult> {
	// BYOC environments are provisioned and owned by QCA. `environment_id` means
	// this project only references that environment, so destroy must never make a
	// remote lifecycle call for it.
	if (isExternalReference(ctx, resource)) {
		ctx.state.removeResource(resource.address);
		return successResult(resource, "reference_removed");
	}

	let provider: ProviderAdapter;
	try {
		provider = getRuntimeProvider(ctx, resource.address.provider);
	} catch (error) {
		return {
			resource,
			status: "skipped",
			reason: "provider_missing",
			error: error instanceof Error ? error.message : String(error),
		};
	}

	if (resource.remote_id === null) {
		ctx.state.removeResource(resource.address);
		return successResult(resource, "destroyed");
	}

	try {
		await deleteRemoteResource(provider, resource.address.type, resource.remote_id, options.cascade);
		ctx.state.removeResource(resource.address);
		emitRuntimeFeedback(options.onFeedback, {
			type: "resource_action_success",
			level: "success",
			resource: resource.address,
			message: `delete ${resource.address.type}.${resource.address.name} (${resource.address.provider})`,
		});
		return successResult(resource, "destroyed");
	} catch (error) {
		if (ApiError.isNotFound(error)) {
			ctx.state.removeResource(resource.address);
			emitRuntimeFeedback(options.onFeedback, {
				type: "resource_already_gone",
				level: "warning",
				resource: resource.address,
				message: `${resource.address.type}.${resource.address.name} (${resource.address.provider}) — already deleted remotely, cleaning up state`,
			});
			return successResult(resource, "already_gone");
		}

		if (resource.address.type === "environment" && !options.cascade && isReferencedError(error)) {
			const blocked = {
				resource,
				status: "blocked",
				reason: "cascade_required",
				error: error instanceof Error ? error.message : String(error),
			} satisfies DestroyResourceResult;
			if (await options.onCascadeRequired?.(blocked)) {
				try {
					await provider.deleteEnvironment(resource.remote_id, true);
					ctx.state.removeResource(resource.address);
					return {
						...successResult(resource, "destroyed"),
						cascaded: true,
					};
				} catch (retryError) {
					return failureResult(resource, retryError);
				}
			}
			return blocked;
		}

		return failureResult(resource, error);
	}
}

function isExternalReference(ctx: ProjectRuntimeContext, resource: ResourceState): boolean {
	if (resource.externally_managed) return true;
	if (resource.address.type === "environment") {
		return Boolean(ctx.config.environments?.[resource.address.name]?.environment_id);
	}
	if (resource.address.type === "identity") {
		return Boolean(ctx.config.identities?.[resource.address.name]?.identity_id);
	}
	return false;
}

function successResult(
	resource: ResourceState,
	reason: "destroyed" | "reference_removed" | "already_gone",
): DestroyResourceResult {
	return { resource, status: "success", reason };
}

function failureResult(resource: ResourceState, error: unknown): DestroyResourceResult {
	return {
		resource,
		status: "failed",
		reason: "failed",
		error: error instanceof Error ? error.message : String(error),
	};
}

async function deleteRemoteResource(
	provider: ProviderAdapter,
	type: ResourceType,
	id: string,
	cascade?: boolean,
): Promise<void> {
	switch (type) {
		case "agent":
			await provider.deleteAgent(id);
			return;
		case "template":
			if (!provider.archiveTemplate) throw new UserError(`Provider does not support templates`);
			await provider.archiveTemplate(id);
			return;
		case "skill":
			await provider.deleteSkill(id);
			return;
		case "memory_store":
			if (!provider.deleteMemoryStore) {
				throw new UserError(`Provider does not support memory stores`);
			}
			await provider.deleteMemoryStore(id);
			return;
		case "vault":
			await provider.deleteVault(id);
			return;
		case "environment":
			await provider.deleteEnvironment(id, cascade);
			return;
		case "deployment":
			await provider.deleteDeployment(id);
			return;
		case "identity":
			if (!provider.deleteIdentity) throw new UserError(`Provider does not support identities`);
			await provider.deleteIdentity(id);
			return;
		case "channel":
			if (!provider.deleteChannel) throw new UserError(`Provider does not support channels`);
			await provider.deleteChannel(id);
			return;
		case "file":
			await provider.deleteFile(id);
			return;
	}
}

function isReferencedError(error: unknown): boolean {
	if (error instanceof ApiError) {
		return error.message.includes("is referenced by");
	}
	return error instanceof Error && error.message.includes("is referenced by");
}
