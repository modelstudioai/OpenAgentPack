import type { ProviderAdapter } from "../providers/interface.ts";
import type { IStateManager } from "../state/state-manager.ts";
import type { ProjectConfig } from "../types/config.ts";
import type { RuntimeFeedbackSink } from "../types/runtime-feedback.ts";

export interface ExecContext {
	readonly config: ProjectConfig;
	readonly configPath?: string;
	readonly providers: Map<string, ProviderAdapter>;
	readonly state: IStateManager;
	readonly onFeedback?: RuntimeFeedbackSink;
	/** Enforce scoped create semantics all the way through remote conflict handling. */
	readonly createOnly?: boolean;
}
