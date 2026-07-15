import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { areRuntimeCredentialsReady, resolveActiveProvider } from "@openagentpack/sdk";
import { readProviderConfig, writeProviderConfig } from "@/lib/agents-config";
import { errorResponses } from "@/schemas/common";
import {
	AgentsConfigReadySchema,
	AgentsConfigSchema,
	AgentsConfigSnapshotSchema,
	SaveAgentsConfigBodySchema,
} from "@/schemas/config";

export const configRoute = new OpenAPIHono();

const getConfigRoute = createRoute({
	method: "get",
	path: "/config",
	responses: {
		200: {
			description: "Read local OpenAgentPack playground config (~/.agents/config.json)",
			content: { "application/json": { schema: AgentsConfigSnapshotSchema } },
		},
		...errorResponses,
	},
});

configRoute.openapi(getConfigRoute, async (c) => {
	const config = await readProviderConfig();
	return c.json(config, 200);
});

const getConfigReadyRoute = createRoute({
	method: "get",
	path: "/config/ready",
	responses: {
		200: {
			description: "Whether runtime provider credentials are configured in the server process",
			content: { "application/json": { schema: AgentsConfigReadySchema } },
		},
		...errorResponses,
	},
});

configRoute.openapi(getConfigReadyRoute, async (c) => {
	const ready = areRuntimeCredentialsReady();
	return c.json({ ready, provider: ready ? resolveActiveProvider() : undefined }, 200);
});

const saveConfigRoute = createRoute({
	method: "put",
	path: "/config",
	request: {
		body: {
			content: { "application/json": { schema: SaveAgentsConfigBodySchema } },
		},
	},
	responses: {
		200: {
			description: "Save local OpenAgentPack playground config (~/.agents/config.json)",
			content: { "application/json": { schema: AgentsConfigSchema } },
		},
		...errorResponses,
	},
});

configRoute.openapi(saveConfigRoute, async (c) => {
	const body = c.req.valid("json");
	const config = await writeProviderConfig(body);
	return c.json(config, 200);
});
