import { z } from "@hono/zod-openapi";
import { CloudEnvironmentSchema } from "@openagentpack/sdk";

export { CloudEnvironmentSchema } from "@openagentpack/sdk";

export const CloudEnvironmentsResponseSchema = z.object({
	environments: z.array(CloudEnvironmentSchema),
});

export const CreateEnvironmentBodySchema = z.object({
	name: z.string().min(1),
	description: z.string().optional(),
	metadata: z.record(z.string(), z.string()).optional(),
});

export const CreateEnvironmentResponseSchema = z.object({
	environment: z.object({
		id: z.string().nullable(),
		type: z.string(),
		version: z.number().optional(),
	}),
});

export const DeleteEnvironmentResponseSchema = z.object({
	id: z.string(),
	type: z.string(),
});

export const EnvironmentParamsSchema = z.object({
	environmentId: z.string().min(1),
});
