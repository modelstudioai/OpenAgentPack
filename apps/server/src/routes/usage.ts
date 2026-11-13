import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { listModelUsage, listToolUsage, readProjectRuntime } from "@openagentpack/sdk";
import { errorResponses } from "@/schemas/common";
import {
	ListModelUsageRequestSchema,
	ListToolUsageRequestSchema,
	ModelUsagePageSchema,
	ToolUsagePageSchema,
} from "@/schemas/usage";
import { projectRuntimeManager } from "@/services/project-manager";

export const usageRoute = new OpenAPIHono();

// Usage analytics proxy the resolved provider's app-control usage.* endpoints. The
// scope/time_range cross rules are validated by the request schemas (session scope
// forbids time_range; workspace/agent require it).
const listModelUsageRoute = createRoute({
	method: "post",
	path: "/usage/models",
	operationId: "listModelUsage",
	request: {
		body: { required: true, content: { "application/json": { schema: ListModelUsageRequestSchema } } },
	},
	responses: {
		200: {
			description: "Paged aggregated model usage for the requested scope",
			content: { "application/json": { schema: ModelUsagePageSchema } },
		},
		...errorResponses,
	},
});

usageRoute.openapi(listModelUsageRoute, async (c) => {
	const request = c.req.valid("json");
	await projectRuntimeManager.ensureStarted();
	const page = await readProjectRuntime(projectRuntimeManager.requireRuntimeInput(), (ctx) => {
		const provider = ctx.config.defaults?.provider;
		return listModelUsage(ctx, request, { provider });
	});
	return c.json(page, 200);
});

const listToolUsageRoute = createRoute({
	method: "post",
	path: "/usage/tools",
	operationId: "listToolUsage",
	request: {
		body: { required: true, content: { "application/json": { schema: ListToolUsageRequestSchema } } },
	},
	responses: {
		200: {
			description: "Paged aggregated tool usage for the requested scope",
			content: { "application/json": { schema: ToolUsagePageSchema } },
		},
		...errorResponses,
	},
});

usageRoute.openapi(listToolUsageRoute, async (c) => {
	const request = c.req.valid("json");
	await projectRuntimeManager.ensureStarted();
	const page = await readProjectRuntime(projectRuntimeManager.requireRuntimeInput(), (ctx) => {
		const provider = ctx.config.defaults?.provider;
		return listToolUsage(ctx, request, { provider });
	});
	return c.json(page, 200);
});
