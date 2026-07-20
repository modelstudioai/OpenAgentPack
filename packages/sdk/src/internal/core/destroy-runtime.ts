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
	executionContext: ProjectRuntimeContext;
}

export interface DestroyProjectOptions {
	cascade?: boolean;
	onFeedback?: RuntimeFeedbackSink;
	onResourceStart?: (resource: ResourceState) => void;
	onResourceResult?: (result: DestroyResourceResult) => void;
	onCascadeRequired?: (result: DestroyResourceResult) => boolean | Promise<boolean>;
}

export interface DestroyProjectResult extends DestroyPlanResult {
	results: DestroyResourceResult[];
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
	return { resources, executionContext: ctx };
}

export async function destroyPlannedProjectResources(
	planned: DestroyPlanResult,
	options: DestroyProjectOptions = {},
): Promise<DestroyProjectResult> {
	const results: DestroyResourceResult[] = [];
	let stateChanged = false;
	const ctx = planned.executionContext;

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

	const destroyed = results.filter((result) => result.status === "success").length;
	return {
		...planned,
		results,
		destroyed,
		partial: destroyed !== planned.resources.length,
	};
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
