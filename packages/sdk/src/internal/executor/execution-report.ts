import type { ProviderAdapter } from "../providers/interface.ts";
import { resourceErrorInfo, resourceRuntimeError } from "../resource-runtime-error.ts";
import type { IStateManager } from "../state/state-manager.ts";
import type { PlannedAction } from "../types/plan.ts";
import type { ResourceActionResult, ResourceExecutionResult } from "../types/resource-result.ts";
import { addressKey } from "../types/state.ts";
import type { ExecContext } from "./context.ts";

const mutations = new Set<keyof ProviderAdapter>([
	"createEnvironment",
	"updateEnvironment",
	"deleteEnvironment",
	"createVault",
	"deleteVault",
	"createSkill",
	"updateSkill",
	"deleteSkill",
	"createAgent",
	"updateAgent",
	"deleteAgent",
	"createTemplate",
	"updateTemplate",
	"archiveTemplate",
	"createIdentity",
	"updateIdentity",
	"deleteIdentity",
	"createChannel",
	"updateChannel",
	"deleteChannel",
	"createMemoryStore",
	"updateMemoryStore",
	"deleteMemoryStore",
	"createMemory",
	"updateMemory",
	"createDeployment",
	"updateDeployment",
	"deleteDeployment",
	"uploadFile",
	"deleteFile",
	"reconcileDefaultMemoryStore",
]);

// Child Memory/Credential IDs must never replace their parent resource's identity.
const identityMutations = new Set<keyof ProviderAdapter>([
	"createEnvironment",
	"updateEnvironment",
	"createVault",
	"createSkill",
	"updateSkill",
	"createAgent",
	"updateAgent",
	"createTemplate",
	"updateTemplate",
	"createIdentity",
	"updateIdentity",
	"createChannel",
	"updateChannel",
	"createMemoryStore",
	"updateMemoryStore",
	"createDeployment",
	"updateDeployment",
	"uploadFile",
]);

function identity(value: unknown): ResourceActionResult["resource"] {
	if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string" || !value.id) return;
	const version = "version" in value ? value.version : undefined;
	return {
		remoteId: value.id,
		...(typeof version === "number" && Number.isSafeInteger(version) && version > 0 ? { version } : {}),
	};
}

function trackProvider<T extends object>(
	provider: T,
	onMutation: () => void,
	onIdentity?: (value: unknown) => void,
): T {
	return new Proxy(provider, {
		get(target, key) {
			const value = Reflect.get(target, key, target);
			if (typeof value !== "function") return value;
			return (...args: unknown[]) => {
				if (mutations.has(key as keyof ProviderAdapter)) onMutation();
				if (key === "createVault" && onIdentity) args[3] = onIdentity;
				const result = value.apply(target, args);
				if (!onIdentity || !identityMutations.has(key as keyof ProviderAdapter)) return result;
				return Promise.resolve(result).then((resource) => {
					onIdentity(resource);
					return resource;
				});
			};
		},
	});
}

/** Captures execution facts without changing the legacy executor result or error path. */
export class ExecutionReportTracker {
	mutationStarted = false;
	private readonly writes = new Set<string>();
	private readonly records = new Map<string, ResourceActionResult>();
	private readonly observed = new Map<string, NonNullable<ResourceActionResult["resource"]>>();
	private readonly initial = new Map<string, NonNullable<ResourceActionResult["resource"]>>();

	constructor(
		private readonly actions: PlannedAction[],
		private readonly state: IStateManager,
	) {
		for (const action of actions) {
			const resource = this.stateResource(action);
			if (resource) this.initial.set(addressKey(action.address), resource);
		}
	}

	private stateResource(action: PlannedAction) {
		const resource =
			this.state.getResource(action.address) ??
			(action.previousAddress ? this.state.getResource(action.previousAddress) : undefined);
		return identity({ id: resource?.remote_id, version: resource?.version });
	}

	provider<T extends object>(provider: T, action: PlannedAction): T {
		return trackProvider(
			provider,
			() => {
				this.mutationStarted = true;
				this.writes.add(addressKey(action.address));
			},
			(value) => {
				const resource = identity(value);
				if (resource) this.observed.set(addressKey(action.address), resource);
			},
		);
	}

	context(context: ExecContext): ExecContext {
		const state = new Proxy(context.state, {
			get: (target, key) => {
				const value = Reflect.get(target, key, target);
				if (key === "save")
					return async () => {
						try {
							await target.save();
						} catch (error) {
							throw resourceRuntimeError(error, {
								code: "resource.state_persist_failed",
								phase: "persist_state",
								mutationStarted: this.mutationStarted,
							});
						}
					};
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		return {
			...context,
			state,
			providers: new Map(
				[...context.providers].map(([name, provider]) => [
					name,
					trackProvider(provider, () => {
						this.mutationStarted = true;
					}),
				]),
			),
			onFeedback: context.onFeedback
				? (event) => {
						try {
							context.onFeedback?.(event);
						} catch (error) {
							throw resourceRuntimeError(error, {
								code: "resource.feedback_failed",
								phase: "execute",
								mutationStarted: this.mutationStarted,
							});
						}
					}
				: undefined,
		};
	}

	record(action: PlannedAction, status: ResourceActionResult["status"], error?: unknown, code?: string): void {
		const mutationStarted = this.writes.has(addressKey(action.address));
		const resource =
			this.observed.get(addressKey(action.address)) ??
			this.stateResource(action) ??
			this.initial.get(addressKey(action.address));
		this.records.set(addressKey(action.address), {
			action,
			status,
			...(error === undefined ? {} : { error: error instanceof Error ? error.message : String(error) }),
			...(status === "success"
				? {}
				: {
						errorInfo: resourceErrorInfo(error, {
							code,
							phase: mutationStarted ? "execute" : "prepare",
							mutationStarted,
						}),
					}),
			...(resource ? { resource } : {}),
		});
	}

	report(error?: unknown): ResourceExecutionResult {
		const results = this.actions
			.filter((action) => action.action !== "no-op")
			.map(
				(action) =>
					this.records.get(addressKey(action.address)) ?? {
						action,
						status: "skipped" as const,
						errorInfo: resourceErrorInfo(undefined, {
							code: "resource.execution_aborted",
							phase: "prepare",
							mutationStarted: false,
						}),
					},
			);
		const failed = results.some((result) => result.status !== "success");
		const unknown =
			(error !== undefined && this.mutationStarted) ||
			results.some((result) => result.status === "failed" && result.errorInfo?.mutationStarted);
		return {
			results,
			partial: results.some((result) => result.status === "failed"),
			mutationStarted: this.mutationStarted,
			outcome: unknown
				? "unknown"
				: error !== undefined
					? "failed"
					: !failed
						? "succeeded"
						: results.some((result) => result.status === "success")
							? "partial"
							: "failed",
		};
	}
}
