import { z } from "@hono/zod-openapi";
import { SessionEventSchema, SessionSchema } from "@openagentpack/sdk";

// Session-runtime DTOs are owned by @openagentpack/sdk (single source of truth, snake_case).
// Here we only re-export them — we do NOT redefine the shapes.
export { SessionEventSchema, SessionSchema };

// List response: { data: Session[], next_page_token? } — envelope composed of core schemas.
export const SessionListResponseSchema = z
	.object({
		data: z.array(SessionSchema),
		next_page_token: z.string().nullish(),
	})
	.openapi("SessionListResponse");

// Detail / create / message response: the session "carrying its events". Composed from
// core schemas (a response envelope, not a new session shape).
export const SessionDetailResponseSchema = z
	.object({
		session: SessionSchema,
		events: z.array(SessionEventSchema),
		events_next_page_token: z.string().nullish(),
	})
	.openapi("SessionDetailResponse");

export const SessionEventsPageResponseSchema = z
	.object({
		events: z.array(SessionEventSchema),
		events_next_page_token: z.string().nullish(),
	})
	.openapi("SessionEventsPageResponse");

// Delete response: confirms which session was removed.
export const SessionDeleteResponseSchema = z
	.object({
		session_id: z.string(),
		deleted: z.boolean(),
	})
	.openapi("SessionDeleteResponse");

// Mode A REST request ergonomics (server-owned input, not the shared DTO).
export const SessionsQuerySchema = z.object({
	// Non-numeric values resolve to `undefined` so the handler clamps to a
	// default instead of the request being rejected with a 400.
	limit: z.preprocess((value) => {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}, z.number().int().optional()),
	agentId: z.string().optional(),
	// Opaque cursor for the next page (provider's next_page / next_page_token, passed through verbatim).
	pageToken: z.string().optional(),
});

export const SessionDetailQuerySchema = z.object({
	agentId: z.string().optional(),
});

export const SessionEventsQuerySchema = z.object({
	agentId: z.string().optional(),
	pageToken: z.string().optional(),
	limit: z.preprocess((value) => {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}, z.number().int().optional()),
});

export const SessionParamsSchema = z.object({
	sessionId: z.string(),
});

export const CreateSessionBodySchema = z.object({
	agentId: z.string(),
	prompt: z.string().min(1),
	// Required: a session must be pinned to a cloud environment (sandbox). Both transports
	// enforce this so Mode A (REST/OpenAPI) and Mode B (console) reject env-less creates.
	environmentId: z.string().min(1),
	// Optional: cloud vault ids to bind a user-supplied credential so the sandbox receives it.
	// Top-level binding shape matches the console createSession.
	vaultIds: z.array(z.string()).optional(),
	title: z.string().optional(),
	// Uploaded files to mount as session resources so the task can read the user's files.
	// Each file needs a mount_path (provider rejects a file resource without one).
	files: z.array(z.object({ fileId: z.string(), mountPath: z.string() })).optional(),
	// Model the agent should run for this session. If present, createSession applies it
	// to the agent config immediately before starting the run.
	model: z.string().optional(),
});

export const SendMessageBodySchema = z.object({
	agentId: z.string().optional(),
	message: z.string().min(1),
});
