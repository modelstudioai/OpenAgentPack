import { z } from "@hono/zod-openapi";

export { DiagnosticSchema, PlannedActionSchema, ResourceAddressSchema } from "@openagentpack/sdk";

export const ErrorResponseSchema = z
	.object({
		error: z.object({
			message: z.string(),
		}),
	})
	.openapi("ErrorResponse");

const errorResponse = (description: string) => ({
	description,
	content: { "application/json": { schema: ErrorResponseSchema } },
});

/**
 * Shared error responses documented on every route. The actual response is
 * produced centrally by `app.onError` (see index.ts).
 */
export const errorResponses = {
	400: errorResponse("Bad request"),
	404: errorResponse("Not found"),
	409: errorResponse("Conflict"),
	500: errorResponse("Server error"),
};
