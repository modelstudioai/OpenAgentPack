import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { getUsageSummary, readProjectRuntime } from "@openagentpack/sdk";
import { errorResponses } from "@/schemas/common";
import { GetUsageSummaryRequestSchema, UsageSummaryResponseSchema } from "@/schemas/usage";
import { projectRuntimeManager } from "@/services/project-manager";

export const usageRoute = new OpenAPIHono();

// Usage analytics proxy the resolved provider's app-control usage.summary endpoint. The
// dimension/time_range cross rules are validated by the request schema (session dimension
// forbids time_range/granularity and requires session_id; workspace/agent require
// time_range, and agent also requires agent_id).
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
	const summary = await readProjectRuntime(projectRuntimeManager.requireRuntimeInput(), (ctx) => {
		const provider = ctx.config.defaults?.provider;
		return getUsageSummary(ctx, request, { provider });
	});
	return c.json(summary, 200);
});
