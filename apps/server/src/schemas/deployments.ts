import { z } from "@hono/zod-openapi";

export const DeploymentStatusSchema = z.object({
	id: z.string(),
	name: z.string(),
	playbookId: z.string(),
	provider: z.string(),
	prompt: z.string(),
	schedule: z.object({ expression: z.string(), timezone: z.string() }),
	status: z.string(),
	remoteId: z.string().nullable(),
});

export const DeploymentListSchema = z.object({ deployments: z.array(DeploymentStatusSchema) });

export const CreateDeploymentBodySchema = z.object({
	name: z.string().min(1),
	playbookId: z.string().min(1),
	prompt: z.string().min(1),
	expression: z.string().min(1),
	timezone: z.string().min(1).default("Asia/Shanghai"),
});

export const SetDeploymentPausedBodySchema = z.object({ paused: z.boolean() });

export const DeploymentRunSchema = z.object({
	name: z.string(),
	provider: z.string(),
	result: z.object({
		run_id: z.string().optional(),
		session_id: z.string().nullable(),
		error: z.object({ type: z.string(), message: z.string() }).optional(),
	}),
});

export const DeleteDeploymentSchema = z.object({ deleted: z.boolean() });
