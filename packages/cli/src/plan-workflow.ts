import * as p from "@clack/prompts";
import { type ProjectRuntimeContext, planProjectContext, type ResourcePlanResult } from "@openagentpack/sdk";
import { log } from "./logger.ts";
import { createRuntimeFeedbackBuffer, renderRuntimeFeedback } from "./render-feedback.ts";

export interface PlanWithRefreshOptions {
	provider?: string;
	refresh?: boolean;
	/** When true, suppress spinner, refresh warning, and live feedback (json mode). */
	quiet?: boolean;
}

export async function planProjectWithRefresh(
	ctx: ProjectRuntimeContext,
	options: PlanWithRefreshOptions = {},
): Promise<ResourcePlanResult> {
	const resourceCount = ctx.state.listResources().length;
	const showRefreshUx = options.refresh !== false && resourceCount > 0 && !options.quiet;

	let spinner: ReturnType<typeof p.spinner> | undefined;
	if (showRefreshUx) {
		spinner = p.spinner({ output: process.stderr });
		spinner.start("Refreshing state...");
	} else if (options.refresh === false && !options.quiet) {
		log.warn("Refresh disabled. Remote drift will not be checked.");
	}

	const feedbackBuffer = spinner ? createRuntimeFeedbackBuffer() : undefined;
	const planned = await planProjectContext(ctx, {
		provider: options.provider,
		refresh: options.refresh,
		quiet: !!options.quiet,
		onFeedback: options.quiet ? undefined : (feedbackBuffer?.onFeedback ?? renderRuntimeFeedback),
	});
	spinner?.stop("State refreshed.");
	feedbackBuffer?.flush();

	return planned;
}
