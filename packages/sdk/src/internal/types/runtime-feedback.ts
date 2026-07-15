import type { PlannedAction } from "./plan.ts";
import type { ResourceAddress } from "./state.ts";

export type RuntimeFeedbackLevel = "info" | "success" | "warning" | "error";

export type RuntimeFeedbackType =
	| "resource_action_success"
	| "resource_action_failed"
	| "resource_already_gone"
	| "resource_adopted"
	| "refresh_resource_missing"
	| "refresh_drift_unchecked"
	| "refresh_resource_failed"
	| "provider_wait";

export interface RuntimeFeedbackEvent {
	type: RuntimeFeedbackType;
	level: RuntimeFeedbackLevel;
	message: string;
	action?: PlannedAction;
	resource?: ResourceAddress;
}

export type RuntimeFeedbackSink = (event: RuntimeFeedbackEvent) => void;

export function emitRuntimeFeedback(sink: RuntimeFeedbackSink | undefined, event: RuntimeFeedbackEvent): void {
	sink?.(event);
}
