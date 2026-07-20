import { UserError } from "../errors.ts";
import { type ExecutionResult, executePlan } from "../executor/executor.ts";
import { getResourceDeclaration } from "../planner/declaration.ts";
import { buildReadinessBaseline } from "../planner/plan-semantics.ts";
import { buildPlan } from "../planner/planner.ts";
import { type RefreshResult, refreshState } from "../planner/refresh.ts";
import { readComparableIfSupported } from "../providers/drift-support.ts";
import type { ExecutionPlan, PlannedAction } from "../types/plan.ts";
import type { RuntimeFeedbackSink } from "../types/runtime-feedback.ts";
import type { ResourceAddress, ResourceState, ResourceType } from "../types/state.ts";
import { contentHash as stableContentHash } from "../utils/hash.ts";
import type { BackendRuntimeInput, ProjectRuntimeContext } from "./project-runtime.ts";
import { readProjectRuntime, writeProjectRuntime } from "./project-runtime.ts";

export interface ResourceRuntimeOptions extends DestructiveDecisionOptions {
	provider?: string;
	refresh?: boolean;
	refreshOnly?: boolean;
	quiet?: boolean;
	onFeedback?: RuntimeFeedbackSink;
}

export interface ResourceRefreshResult {
	removed: ResourceState[];
	errors: Array<{ resource: ResourceState; error: string }>;
}

export interface ResourceActionResult {
	action: PlannedAction;
	status: "success" | "failed" | "skipped";
	error?: string;
}

export interface ResourceExecutionResult {
	results: ResourceActionResult[];
	partial: boolean;
}

export interface ResourcePlanResult {
	executionContext: ProjectRuntimeContext;
	plan: ExecutionPlan;
	refreshResult?: ResourceRefreshResult;
	targetProviders?: string[];
	destructiveActions: PlannedAction[];
}

export type DestructivePolicy = "block" | "prompt" | "force";

export interface DestructiveDecisionOptions {
	policy?: DestructivePolicy;
	confirm?: (actions: PlannedAction[]) => boolean | Promise<boolean>;
}

export interface ResourceSyncRun {
	planned: ResourcePlanResult;
	execution?: ResourceExecutionResult;
}

export async function planProjectWithStateBackend(
	input: BackendRuntimeInput,
	options: ResourceRuntimeOptions = {},
): Promise<ResourcePlanResult> {
	return readProjectRuntime(input, (ctx) => planProjectContext(ctx, options));
}

export async function syncProjectResourcesWithStateBackend(
	input: BackendRuntimeInput,
	options: ResourceRuntimeOptions = {},
): Promise<ResourceSyncRun> {
	return writeProjectRuntime(input, async (ctx) => {
		const planned = await planProjectContext(ctx, options);
		if (options.refreshOnly) {
			return { planned };
		}
		return {
			planned,
			execution: await executePlannedProject(planned, {
				onFeedback: options.onFeedback,
				policy: options.policy,
				confirm: options.confirm,
			}),
		};
	});
}

const IMPORTABLE_RESOURCE_TYPES = new Set<ResourceType>([
	"environment",
	"vault",
	"memory_store",
	"skill",
	"agent",
	"template",
	"identity",
	"channel",
]);

// Adopt an existing remote resource into state: derive its content hash from the
// plan's create action and record it. Owns which resource types may be imported.
export async function importResource(
	ctx: ProjectRuntimeContext,
	address: ResourceAddress,
	remoteId: string,
	options: { resourceVersion?: number } = {},
): Promise<ResourceState> {
	if (!IMPORTABLE_RESOURCE_TYPES.has(address.type)) {
		throw new UserError(
			`Invalid resource type: ${address.type}. Valid types: ${[...IMPORTABLE_RESOURCE_TYPES].join(", ")}`,
		);
	}
	if (ctx.state.getResource(address)) {
		throw new UserError(
			`Resource ${address.provider}.${address.type}.${address.name} already exists in state. Remove it before re-importing.`,
		);
	}

	const planned = await planProjectContext(ctx, {
		provider: address.provider,
		refresh: false,
		quiet: true,
	});
	const action = planned.plan.actions.find(
		(item) =>
			item.address.provider === address.provider &&
			item.address.type === address.type &&
			item.address.name === address.name,
	);
	if (action?.action !== "create") {
		throw new UserError(`Resource ${address.type}.${address.name} is not declared in the project config.`);
	}

	const contentHash = (action.after as { content_hash?: string } | undefined)?.content_hash;
	if (!contentHash) {
		throw new UserError(`Planned ${address.type}.${address.name} is missing a content hash.`);
	}

	// Read back the actual remote state as the drift baseline. Without it the
	// first plan after import would compare the remote against the *desired*
	// comparable and report a one-time phantom "Remote drift detected" — most
	// visibly for external-reference environments OpenCMA never configured.
	const provider = ctx.providers.get(address.provider);
	const remote = provider ? await readComparableIfSupported(provider, address.type, remoteId, address.name) : null;
	const remoteHash = remote ? stableContentHash(remote.comparable) : undefined;

	const resource: ResourceState = {
		address,
		remote_id: remoteId,
		externally_managed:
			address.type === "environment" && ctx.config.environments?.[address.name]?.environment_id ? true : undefined,
		version: options.resourceVersion ?? remote?.version,
		content_hash: contentHash,
		desired_hash: contentHash,
		desired_comparable_hash: remoteHash,
		desired_readiness_baseline: buildReadinessBaseline(getResourceDeclaration(address, ctx.config)),
		remote_hash: remoteHash,
		remote_snapshot: remote ? (remote.snapshot ?? remote.comparable) : undefined,
		drift_status: remoteHash ? "in_sync" : undefined,
	};
	ctx.state.setResource(resource);
	await ctx.state.save();
	return resource;
}

export async function planProjectContext(
	ctx: ProjectRuntimeContext,
	options: ResourceRuntimeOptions = {},
): Promise<ResourcePlanResult> {
	const targetProviders = resolveTargetProviders(options.provider);
	const refreshResult =
		options.refresh !== false && ctx.state.listResources().length > 0
			? await refreshState(ctx.state, ctx.providers, {
					targetProviders,
					config: ctx.config,
					quiet: options.quiet ?? true,
					onFeedback: options.onFeedback,
				})
			: undefined;

	const plan = await buildPlan(ctx.config, ctx.state.getStateFile(), {
		providers: targetProviders,
		configPath: ctx.configPath,
	});

	return {
		executionContext: ctx,
		plan,
		refreshResult: toResourceRefreshResult(refreshResult),
		targetProviders,
		destructiveActions: selectDestructive(plan.actions),
	};
}

export async function executePlannedProject(
	planned: ResourcePlanResult,
	options: DestructiveDecisionOptions & {
		onFeedback?: RuntimeFeedbackSink;
		concurrency?: number;
	} = {},
): Promise<ResourceExecutionResult> {
	const decision = await decideDestructive(planned.destructiveActions, {
		policy: options.policy,
		confirm: options.confirm,
	});
	if (decision !== "proceed") {
		throw new UserError(
			decision === "cancelled"
				? "Destructive actions were declined. No remote resources were changed."
				: "Current plan contains destructive actions. Apply will not delete remote resources.",
		);
	}

	const ctx = planned.executionContext;
	const execution = await executePlan(
		planned.plan,
		{
			config: ctx.config,
			configPath: ctx.configPath,
			providers: ctx.providers,
			state: ctx.state,
			onFeedback: options.onFeedback,
		},
		{ concurrency: options.concurrency },
	);
	return toResourceExecutionResult(execution);
}

export function resolveTargetProviders(provider?: string): string[] | undefined {
	if (!provider || provider === "all") return undefined;
	return [provider];
}

export function selectDestructive(actions: PlannedAction[]): PlannedAction[] {
	return actions.filter((action) => action.action === "delete");
}

// Single decision point for how a destructive plan should proceed. Both the
// project (CLI) and agent (webui) paths route through this so the policy lives
// in one place; hosts differ only in the confirm callback.
export async function decideDestructive(
	destructiveActions: PlannedAction[],
	options: DestructiveDecisionOptions = {},
): Promise<"proceed" | "blocked" | "cancelled"> {
	if (destructiveActions.length === 0) return "proceed";
	switch (options.policy ?? "block") {
		case "force":
			return "proceed";
		case "prompt":
			if (!options.confirm) return "blocked";
			return (await options.confirm(destructiveActions)) ? "proceed" : "cancelled";
		default:
			return "blocked";
	}
}

export function replaceResourcePlan(planned: ResourcePlanResult, plan: ExecutionPlan): ResourcePlanResult {
	return {
		...planned,
		plan,
		destructiveActions: selectDestructive(plan.actions),
	};
}

function toResourceRefreshResult(result: RefreshResult | undefined): ResourceRefreshResult | undefined {
	if (!result) return undefined;
	return {
		removed: result.removed,
		errors: result.errors.map((item) => ({
			resource: item.resource,
			error: item.error.message,
		})),
	};
}

function toResourceExecutionResult(result: ExecutionResult): ResourceExecutionResult {
	return {
		results: result.results.map((item) => ({
			action: item.action,
			status: item.status,
			error: item.error?.message,
		})),
		partial: result.partial,
	};
}
