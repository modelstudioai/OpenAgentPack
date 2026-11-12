import type { PlannedAction } from "./plan.ts";

/** Detailed contracts are opt-in; the default public result retains its legacy shape. */
export type ResourceResultDetail = "legacy" | "structured";
export type ResourceExecutionOutcome = "succeeded" | "failed" | "partial" | "unknown";
export type ResourceErrorPhase = "plan" | "prepare" | "execute" | "persist_state";

export interface ResourceErrorInfo {
	code: string;
	phase: ResourceErrorPhase;
	/** Safe summary, never a raw Provider response or request. */
	message: string;
	/** Transient failure hint, not permission to replay a mutation. */
	retryable: boolean;
	/** False only when no mutating Provider method has been invoked. */
	mutationStarted: boolean;
	httpStatus?: number;
}

export interface ResourceActionResult {
	action: PlannedAction;
	status: "success" | "failed" | "skipped";
	error?: string;
	errorInfo?: ResourceErrorInfo;
	resource?: { remoteId: string; version?: number };
}

export interface ResourceExecutionResult {
	results: ResourceActionResult[];
	/** Legacy meaning: at least one action failed. */
	partial: boolean;
	outcome?: ResourceExecutionOutcome;
	mutationStarted?: boolean;
}
