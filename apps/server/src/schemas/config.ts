import { z } from "@hono/zod-openapi";
import { AGENTS_CONFIG_PROVIDERS } from "@/lib/agents-config";

export const AgentsConfigSchema = z
	.object({
		AGENTS_PROVIDER: z.enum(AGENTS_CONFIG_PROVIDERS),
	})
	.catchall(z.string())
	.openapi("AgentsConfig");

/** GET /config returns the effective provider config (on-disk ~/.agents/config.json with process.env fallback). */
export const AgentsConfigSnapshotSchema = z
	.object({
		AGENTS_PROVIDER: z.enum(AGENTS_CONFIG_PROVIDERS).optional(),
	})
	.catchall(z.string().optional())
	.openapi("AgentsConfigSnapshot");

export const SaveAgentsConfigBodySchema = z
	.object({
		AGENTS_PROVIDER: z.enum(AGENTS_CONFIG_PROVIDERS),
	})
	.catchall(z.string())
	.openapi("SaveAgentsConfigBody");

export const AgentsConfigReadySchema = z
	.object({
		ready: z.boolean(),
		provider: z.enum(AGENTS_CONFIG_PROVIDERS).optional(),
	})
	.openapi("AgentsConfigReady");
