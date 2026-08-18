import { createHash } from "node:crypto";
import {
	type BackendRuntimeInput,
	type Diagnostic,
	executePlannedProject,
	type PlannedAction,
	planProjectContext,
	type ResourceExecutionResult,
	type RuntimeFeedbackSink,
	readProjectRuntime,
	writeProjectRuntime,
} from "@openagentpack/sdk";

export interface ProjectRuntimePlan {
	fingerprint: string;
	actions: PlannedAction[];
	diagnostics: Diagnostic[];
	destructiveActions: PlannedAction[];
}

export async function planProjectRuntimeResources(
	input: BackendRuntimeInput,
	options: { refresh?: boolean; onFeedback?: RuntimeFeedbackSink } = {},
): Promise<ProjectRuntimePlan> {
	return readProjectRuntime(input, async (context) => {
		const planned = await planProjectContext(context, {
			refresh: options.refresh,
			quiet: true,
			onFeedback: options.onFeedback,
		});
		return scopeProjectRuntimePlan(planned.plan.actions, planned.plan.diagnostics);
	});
}

export async function applyProjectRuntimeResources(
	input: BackendRuntimeInput,
	expectedFingerprint: string,
	options: { onFeedback?: RuntimeFeedbackSink } = {},
): Promise<{ plan: ProjectRuntimePlan; execution: ResourceExecutionResult }> {
	return writeProjectRuntime(input, async (context) => {
		const planned = await planProjectContext(context, {
			refresh: true,
			quiet: true,
			onFeedback: options.onFeedback,
		});
		const scoped = scopeProjectRuntimePlan(planned.plan.actions, planned.plan.diagnostics);
		if (scoped.fingerprint !== expectedFingerprint) {
			throw Object.assign(new Error("Plan is stale because project or remote resources changed. Create a new plan."), {
				status: 409,
			});
		}
		const execution = await executePlannedProject(
			{
				...planned,
				plan: { ...planned.plan, actions: scoped.actions, diagnostics: scoped.diagnostics },
				destructiveActions: scoped.destructiveActions,
			},
			{ policy: "force", onFeedback: options.onFeedback },
		);
		const failed = execution.results.find((result) => result.status !== "success");
		if (failed)
			throw Object.assign(new Error(failed.error ?? `${failed.action.address.type} apply failed.`), { status: 422 });
		return { plan: scoped, execution };
	});
}

export function scopeProjectRuntimePlan(actions: PlannedAction[], diagnostics: Diagnostic[]): ProjectRuntimePlan {
	const scopedActions = actions.filter((action) => isRuntimeResourceType(action.address.type));
	const scopedDiagnostics = diagnostics.filter(
		(diagnostic) => !diagnostic.resource || isRuntimeResourceType(diagnostic.resource.type),
	);
	const destructiveActions = scopedActions.filter((action) => action.action === "delete");
	return {
		fingerprint: stableFingerprint({ actions: scopedActions, diagnostics: scopedDiagnostics }),
		actions: scopedActions,
		diagnostics: scopedDiagnostics,
		destructiveActions,
	};
}

function isRuntimeResourceType(type: string): boolean {
	return type !== "deployment" && type !== "channel";
}

function stableFingerprint(value: unknown): string {
	return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.filter(([, entry]) => entry !== undefined)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}
