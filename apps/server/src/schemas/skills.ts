import { z } from "@hono/zod-openapi";

export const ProviderSkillInfoSchema = z
	.object({
		id: z.string(),
		name: z.string(),
		description: z.string().optional(),
		source: z.enum(["custom", "official"]),
		status: z.enum(["checking", "active", "rejected", "deleted"]),
		latest_version: z.string().optional(),
		created_at: z.string().optional(),
		updated_at: z.string().optional(),
	})
	.openapi("ProviderSkillInfo");

export const UploadSkillFileFormSchema = z.object({
	file: z.instanceof(File).openapi({ type: "string", format: "binary" }),
});

export const CreateSkillBodySchema = z.object({
	fileId: z.string().min(1),
});

export const WarmSkillBodySchema = z.object({
	name: z.string().min(1),
	url: z.string().min(1),
});

export const WarmSkillResponseSchema = z.object({
	ok: z.literal(true),
});

export const SkillsQuerySchema = z.object({
	source: z.enum(["custom", "official"]).optional(),
});

export const SkillsResponseSchema = z.object({
	skills: z.array(ProviderSkillInfoSchema),
});

export const SkillStatusesBodySchema = z.object({
	skillIds: z.array(z.string()),
});

export const SkillStatusInfoSchema = z.object({
	id: z.string(),
	status: z.enum(["checking", "active", "rejected", "deleted"]).optional(),
});

export const SkillStatusesResponseSchema = z.object({
	skills: z.array(SkillStatusInfoSchema),
});

export const SkillParamsSchema = z.object({
	id: z.string().min(1),
});
