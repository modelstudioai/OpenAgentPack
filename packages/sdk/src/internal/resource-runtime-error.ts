import { ApiError } from "./providers/base-client.ts";
import type { ResourceErrorInfo, ResourceErrorPhase, ResourceExecutionResult } from "./types/resource-result.ts";

const summaries: Record<string, string> = {
	"resource.plan_failed": "Resource planning failed.",
	"resource.prepare_failed": "Resource preparation failed.",
	"resource.provider_not_configured": "Resource Provider is not configured.",
	"resource.provider_failed": "Resource Provider request failed.",
	"resource.state_persist_failed": "Resource state could not be persisted.",
	"resource.feedback_failed": "Resource execution feedback could not be delivered.",
	"resource.dependency_failed": "A required dependency failed; this action was skipped.",
	"resource.execution_aborted": "Execution stopped before this action completed.",
	"resource.policy_blocked": "The resource plan requires destructive confirmation.",
	"resource.cancelled": "Resource execution was cancelled.",
	"resource.unknown": "Resource execution failed; its result requires verification.",
};

/** Only structured resource operations throw this class. Legacy callers keep original exceptions. */
export class ResourceRuntimeError extends Error {
	readonly info: ResourceErrorInfo;
	readonly execution?: ResourceExecutionResult;

	constructor(
		message: string,
		info: ResourceErrorInfo,
		options: { cause?: unknown; execution?: ResourceExecutionResult } = {},
	) {
		super(message, { cause: options.cause });
		this.name = "ResourceRuntimeError";
		this.info = info;
		this.execution = options.execution;
	}
}

export function resourceErrorInfo(
	error: unknown,
	options: { phase: ResourceErrorPhase; mutationStarted: boolean; code?: string },
): ResourceErrorInfo {
	if (error instanceof ResourceRuntimeError)
		return { ...error.info, mutationStarted: options.mutationStarted || error.info.mutationStarted };
	const httpStatus = error instanceof ApiError ? error.statusCode : undefined;
	const code =
		options.code ??
		(httpStatus
			? "resource.provider_failed"
			: options.phase === "plan"
				? "resource.plan_failed"
				: options.mutationStarted
					? "resource.unknown"
					: "resource.prepare_failed");
	return {
		code,
		phase: options.phase,
		message:
			summaries[code] ?? (options.phase === "plan" ? "Resource plan is invalid." : summaries["resource.unknown"]!),
		retryable: httpStatus !== undefined && (httpStatus === 429 || httpStatus >= 500),
		mutationStarted: options.mutationStarted,
		...(httpStatus === undefined ? {} : { httpStatus }),
	};
}

export function resourceRuntimeError(
	error: unknown,
	options: Parameters<typeof resourceErrorInfo>[1],
	execution?: ResourceExecutionResult,
): ResourceRuntimeError {
	return new ResourceRuntimeError(
		error instanceof Error ? error.message : String(error),
		resourceErrorInfo(error, options),
		{
			cause: error,
			execution,
		},
	);
}
