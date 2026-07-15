import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { PLAYBOOK_AGENT_NAME_PREFIX } from "@openagentpack/playbooks";
import { archiveCloudAgent, listAgentsWithReadiness, listCloudAgents } from "@openagentpack/sdk";
import {
	AgentsQuerySchema,
	AgentsResponseSchema,
	ArchiveCloudAgentParamsSchema,
	ArchiveCloudAgentResponseSchema,
	CloudAgentsQuerySchema,
	CloudAgentsResponseSchema,
	UpdateCloudAgentBodySchema,
	UpdateCloudAgentParamsSchema,
	UpdateCloudAgentResponseSchema,
} from "@/schemas/agents";
import { errorResponses } from "@/schemas/common";
import { DEFAULT_AGENT_ID } from "@/services/agents/catalog";
import { withAgentRuntime } from "@/services/runtime-factory";
import { updatePlaybookAgentModel } from "@/services/sessions/runner";

export const agentsRoute = new OpenAPIHono();

const listAgentsRoute = createRoute({
	method: "get",
	path: "/agents",
	request: {
		query: AgentsQuerySchema,
	},
	responses: {
		200: {
			description: "List agents with readiness",
			content: { "application/json": { schema: AgentsResponseSchema } },
		},
		...errorResponses,
	},
});

agentsRoute.openapi(listAgentsRoute, async (c) => {
	const { agentId: rawAgentId } = c.req.valid("query");
	const agentId = rawAgentId?.trim() || DEFAULT_AGENT_ID;
	const agents = await withAgentRuntime(agentId, (ctx) => listAgentsWithReadiness(ctx, { refresh: false }));
	return c.json({ agents: agents.map(({ agent, readiness }) => ({ agent, readiness })) }, 200);
});

const listCloudAgentsRoute = createRoute({
	method: "get",
	path: "/cloud-agents",
	request: {
		query: CloudAgentsQuerySchema,
	},
	responses: {
		200: {
			description: "List raw cloud agents (the resource center's source of truth)",
			content: { "application/json": { schema: CloudAgentsResponseSchema } },
		},
		...errorResponses,
	},
});

// Raw cloud agents — the actual remote objects, scoped to the Agents/ playbook family by name
// prefix. Unlike /agents (local config + readiness), this surfaces same-name duplicates
// and identity-stamp drift the resource center is built to expose.
agentsRoute.openapi(listCloudAgentsRoute, async (c) => {
	const { prefix } = c.req.valid("query");
	const agents = await withAgentRuntime(DEFAULT_AGENT_ID, (ctx) =>
		listCloudAgents(ctx, { prefix: prefix?.trim() || PLAYBOOK_AGENT_NAME_PREFIX, limit: 100 }),
	);
	return c.json({ agents }, 200);
});

const archiveCloudAgentRoute = createRoute({
	method: "post",
	path: "/cloud-agents/{agentId}/archive",
	request: {
		params: ArchiveCloudAgentParamsSchema,
	},
	responses: {
		200: {
			description: "Archive a cloud agent (soft delete → status=archived)",
			content: { "application/json": { schema: ArchiveCloudAgentResponseSchema } },
		},
		...errorResponses,
	},
});

agentsRoute.openapi(archiveCloudAgentRoute, async (c) => {
	const { agentId } = c.req.valid("param");
	await withAgentRuntime(DEFAULT_AGENT_ID, (ctx) => archiveCloudAgent(ctx, agentId));
	return c.json({ ok: true } as const, 200);
});

const updateCloudAgentRoute = createRoute({
	method: "post",
	path: "/cloud-agents/{agentId}",
	request: {
		params: UpdateCloudAgentParamsSchema,
		body: {
			content: { "application/json": { schema: UpdateCloudAgentBodySchema } },
		},
	},
	responses: {
		200: {
			description: "Update a playbook agent's config (model switch → sync-override)",
			content: { "application/json": { schema: UpdateCloudAgentResponseSchema } },
		},
		...errorResponses,
	},
});

// Switch a playbook agent's model. agentId is the playbook slug; the service resolves it to the
// compiled runtime agent and syncs the new model to the remote agent. A no-op when the agent
// isn't provisioned yet — the model then rides the next createSession.
agentsRoute.openapi(updateCloudAgentRoute, async (c) => {
	const { agentId } = c.req.valid("param");
	const { model } = c.req.valid("json");
	await updatePlaybookAgentModel(agentId, model);
	return c.json({ ok: true } as const, 200);
});
