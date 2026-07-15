import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { getEnvironmentProfile } from "@openagentpack/playbooks";
import { createCloudEnvironment, deleteCloudEnvironment, listCloudEnvironments } from "@openagentpack/sdk";
import { resolveRuntimeProvider } from "@/lib/build-runtime-config";
import { errorResponses } from "@/schemas/common";
import {
	CloudEnvironmentsResponseSchema,
	CreateEnvironmentBodySchema,
	CreateEnvironmentResponseSchema,
	DeleteEnvironmentResponseSchema,
	EnvironmentParamsSchema,
} from "@/schemas/environments";
import { DEFAULT_AGENT_ID } from "@/services/agents/catalog";
import { withAgentRuntime } from "@/services/runtime-factory";

export const environmentsRoute = new OpenAPIHono();

const listEnvironmentsRoute = createRoute({
	method: "get",
	path: "/environments",
	responses: {
		200: {
			description: "List raw cloud environments (the shared base sandbox resource)",
			content: { "application/json": { schema: CloudEnvironmentsResponseSchema } },
		},
		...errorResponses,
	},
});

// Raw cloud environments — the shared base sandbox(es) sessions run inside. Not scoped to any
// playbook/agent. The webui entry check uses this to detect a missing base environment.
environmentsRoute.openapi(listEnvironmentsRoute, async (c) => {
	const environments = await withAgentRuntime(DEFAULT_AGENT_ID, (ctx) => listCloudEnvironments(ctx));
	return c.json({ environments }, 200);
});

const createEnvironmentRoute = createRoute({
	method: "post",
	path: "/environments",
	request: {
		body: {
			content: { "application/json": { schema: CreateEnvironmentBodySchema } },
		},
	},
	responses: {
		200: {
			description: "Create a base cloud environment (cloud + unrestricted networking)",
			content: { "application/json": { schema: CreateEnvironmentResponseSchema } },
		},
		...errorResponses,
	},
});

// Provision the default base environment when the entry check finds none. Every provider needs
// a sandbox; the config is single-sourced from the playbooks catalog — bailian installs
// `bailian-cli`, others ship a bare cloud sandbox (no packages).
environmentsRoute.openapi(createEnvironmentRoute, async (c) => {
	const { name, description, metadata } = c.req.valid("json");
	const profile = getEnvironmentProfile(resolveRuntimeProvider());
	const environment = await withAgentRuntime(DEFAULT_AGENT_ID, (ctx) =>
		createCloudEnvironment(ctx, name, {
			description,
			metadata,
			config: profile.config,
		}),
	);
	return c.json({ environment }, 200);
});

const deleteEnvironmentRoute = createRoute({
	method: "delete",
	path: "/environments/{environmentId}",
	request: {
		params: EnvironmentParamsSchema,
	},
	responses: {
		200: {
			description: "Delete a cloud environment by remote id",
			content: { "application/json": { schema: DeleteEnvironmentResponseSchema } },
		},
		...errorResponses,
	},
});

// Delete a cloud environment by its remote id. The resource center exposes this for the
// managed base sandbox; the upstream provider rejects deletion of an environment still in
// use, so a clean delete implies no live session depends on it.
environmentsRoute.openapi(deleteEnvironmentRoute, async (c) => {
	const { environmentId } = c.req.valid("param");
	await withAgentRuntime(DEFAULT_AGENT_ID, (ctx) => deleteCloudEnvironment(ctx, environmentId));
	return c.json({ id: environmentId, type: "environment_deleted" }, 200);
});
