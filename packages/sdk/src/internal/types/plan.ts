import type { Diagnostic, PlannedAction } from "./dto.ts";

export type {
	ActionType,
	Diagnostic,
	DiagnosticSeverity,
	PlannedAction,
} from "./dto.ts";

export interface ExecutionPlan {
	actions: PlannedAction[];
	diagnostics: Diagnostic[];
}
