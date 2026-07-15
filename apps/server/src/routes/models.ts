import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { DEFAULT_PLAYBOOK_PROVIDER, PROVIDER_DEFAULTS } from "@openagentpack/playbooks";
import { listProviderModelsForContext } from "@openagentpack/sdk";
import { errorResponses } from "@/schemas/common";
import { ModelsResponseSchema } from "@/schemas/models";
import { DEFAULT_AGENT_ID } from "@/services/agents/catalog";
import { withAgentRuntime } from "@/services/runtime-factory";

export const modelsRoute = new OpenAPIHono();

const listModelsRoute = createRoute({
	method: "get",
	path: "/models",
	responses: {
		200: {
			description: "List the active provider's available models",
			content: { "application/json": { schema: ModelsResponseSchema } },
		},
		...errorResponses,
	},
});

// The server targets a single provider (AGENTS_PROVIDER). Enumerate that provider's models via
// its adapter's dynamic-listing seam. Providers without dynamic listing (e.g. bailian) yield an
// empty list; the frontend then falls back to its bundled catalog.
modelsRoute.openapi(listModelsRoute, async (c) => {
	const models = await withAgentRuntime(DEFAULT_AGENT_ID, async (ctx) => {
		const provider = ctx.config.defaults?.provider;
		const [listing] = await listProviderModelsForContext(ctx.providers, provider);
		if (listing?.models.length) return listing.models;
		// Bailian has no dynamic listing — the UI keeps its bundled catalog. Other providers
		// without listModels must not fall through to that catalog; surface the catalog default.
		if (provider && provider !== DEFAULT_PLAYBOOK_PROVIDER) {
			const defaultModel = PROVIDER_DEFAULTS[provider]?.model;
			if (defaultModel) {
				return [{ id: defaultModel, display_name: defaultModel, is_enabled: true, is_new: false }];
			}
		}
		return [];
	});
	return c.json({ models }, 200);
});
