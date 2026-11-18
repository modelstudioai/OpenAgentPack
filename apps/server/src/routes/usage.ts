import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { ApiError, getUsageSummary, readProjectRuntime, UserError } from "@openagentpack/sdk";
import { errorResponses } from "@/schemas/common";
import { GetUsageSummaryRequestSchema, UsageSummaryResponseSchema } from "@/schemas/usage";
import { projectRuntimeManager } from "@/services/project-manager";

export const usageRoute = new OpenAPIHono();

// Usage analytics proxy the resolved provider's app-control usage.summary endpoint. The
// request schema validates one strict branch per dimension (session requires session_id
// and takes nothing else; workspace/agent require time_range, and agent also requires
// agent_id), so contract violations answer 400 before any upstream call.
const getUsageSummaryRoute = createRoute({
	method: "post",
	path: "/usage/summary",
	operationId: "getUsageSummary",
	request: {
		body: { required: true, content: { "application/json": { schema: GetUsageSummaryRequestSchema } } },
	},
	responses: {
		200: {
			description: "Aggregated usage for the requested dimension: scope totals plus model/tool detail views",
			content: { "application/json": { schema: UsageSummaryResponseSchema } },
		},
		...errorResponses,
	},
});

usageRoute.openapi(getUsageSummaryRoute, async (c) => {
	const request = c.req.valid("json");
	await projectRuntimeManager.ensureStarted();
	try {
		const summary = await readProjectRuntime(projectRuntimeManager.requireRuntimeInput(), (ctx) => {
			const provider = ctx.config.defaults?.provider;
			return getUsageSummary(ctx, request, { provider });
		});
		return c.json(summary, 200);
	} catch (error) {
		// Bailian business errors keep the upstream status on ApiError (404 not_found,
		// 400 query_limit_exceeded), and contract rejections are the caller's fault.
		// Neither may fall through to the central handler's 500 default; the status
		// rides along for `app.onError` to format.
		if (error instanceof ApiError) throw statusError(error.message, error.statusCode);
		if (error instanceof UserError) throw statusError(error.message, 400);
		throw error;
	}
});

function statusError(message: string, status: number): Error & { status: number } {
	return Object.assign(new Error(message), { status });
}
