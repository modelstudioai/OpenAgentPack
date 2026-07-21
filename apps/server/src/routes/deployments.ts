import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { errorResponses } from "@/schemas/common";
import {
	CreateDeploymentBodySchema,
	DeleteDeploymentSchema,
	DeploymentListSchema,
	DeploymentRunSchema,
	DeploymentStatusSchema,
	SetDeploymentPausedBodySchema,
} from "@/schemas/deployments";
import {
	createManagedDeployment,
	deleteManagedDeployment,
	listManagedDeployments,
	runManagedDeployment,
	setManagedDeploymentPaused,
} from "@/services/deployments/manage";

export const deploymentsRoute = new OpenAPIHono();
const idParam = z.object({ id: z.string().min(1) });

const listRoute = createRoute({
	method: "get",
	path: "/deployments",
	responses: {
		200: { description: "List managed deployments", content: { "application/json": { schema: DeploymentListSchema } } },
		...errorResponses,
	},
});
deploymentsRoute.openapi(listRoute, async (c) => c.json({ deployments: await listManagedDeployments() }, 200));

const createRouteDef = createRoute({
	method: "post",
	path: "/deployments",
	request: { body: { content: { "application/json": { schema: CreateDeploymentBodySchema } } } },
	responses: {
		201: {
			description: "Create a native deployment",
			content: { "application/json": { schema: DeploymentStatusSchema } },
		},
		...errorResponses,
	},
});
deploymentsRoute.openapi(createRouteDef, async (c) => c.json(await createManagedDeployment(c.req.valid("json")), 201));

const pauseRoute = createRoute({
	method: "put",
	path: "/deployments/{id}/paused",
	request: { params: idParam, body: { content: { "application/json": { schema: SetDeploymentPausedBodySchema } } } },
	responses: {
		200: {
			description: "Pause or resume a deployment",
			content: {
				"application/json": { schema: z.object({ id: z.string().nullable(), status: z.string() }).passthrough() },
			},
		},
		...errorResponses,
	},
});
deploymentsRoute.openapi(pauseRoute, async (c) =>
	c.json(await setManagedDeploymentPaused(c.req.valid("param").id, c.req.valid("json").paused), 200),
);

const runRoute = createRoute({
	method: "post",
	path: "/deployments/{id}/runs",
	request: { params: idParam },
	responses: {
		201: { description: "Trigger a deployment run", content: { "application/json": { schema: DeploymentRunSchema } } },
		...errorResponses,
	},
});
deploymentsRoute.openapi(runRoute, async (c) => c.json(await runManagedDeployment(c.req.valid("param").id), 201));

const deleteRoute = createRoute({
	method: "delete",
	path: "/deployments/{id}",
	request: { params: idParam },
	responses: {
		200: { description: "Delete a deployment", content: { "application/json": { schema: DeleteDeploymentSchema } } },
		...errorResponses,
	},
});
deploymentsRoute.openapi(deleteRoute, async (c) => c.json(await deleteManagedDeployment(c.req.valid("param").id), 200));
