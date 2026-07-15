import { z } from "@hono/zod-openapi";
import { AgentWithReadinessSchema, CloudAgentSchema } from "@openagentpack/sdk";

export {
	AgentDefinitionSchema,
	AgentReadinessSchema,
	AgentSkillRefSchema,
	CloudAgentSchema,
} from "@openagentpack/sdk";
export { AgentWithReadinessSchema };

export const AgentsResponseSchema = z.object({
	agents: z.array(AgentWithReadinessSchema),
});

export const AgentsQuerySchema = z.object({
	agentId: z.string().optional(),
});

export const CloudAgentsResponseSchema = z.object({
	agents: z.array(CloudAgentSchema),
});

export const CloudAgentsQuerySchema = z.object({
	prefix: z.string().optional(),
});

export const ArchiveCloudAgentParamsSchema = z.object({
	agentId: z.string().min(1),
});

export const ArchiveCloudAgentResponseSchema = z.object({
	ok: z.literal(true),
});

// agentId here is a playbook SLUG (not a remote agent_ id) — the route resolves it via the catalog.
export const UpdateCloudAgentParamsSchema = z.object({
	agentId: z.string().min(1),
});

export const UpdateCloudAgentBodySchema = z.object({
	model: z.string().min(1),
});

export const UpdateCloudAgentResponseSchema = z.object({
	ok: z.literal(true),
});
