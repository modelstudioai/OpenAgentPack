import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { ErrorResponseSchema, errorResponses } from "@/schemas/common";
import { ProviderFileInfoSchema } from "@/schemas/files";
import {
	CreateSkillBodySchema,
	ProviderSkillInfoSchema,
	SkillParamsSchema,
	SkillStatusesBodySchema,
	SkillStatusesResponseSchema,
	SkillsQuerySchema,
	SkillsResponseSchema,
	UploadSkillFileFormSchema,
	WarmSkillBodySchema,
	WarmSkillResponseSchema,
} from "@/schemas/skills";
import {
	createUserSkillFromFile,
	deleteUserSkill,
	getUserSkillStatuses,
	listUserSkills,
	uploadUserSkillFile,
	warmSkillByUrl,
} from "@/services/skills/manage";

export const skillsRoute = new OpenAPIHono();

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

const uploadSkillFileRoute = createRoute({
	method: "post",
	path: "/skills/upload-file",
	operationId: "uploadSkillFile",
	request: {
		body: {
			required: true,
			content: { "multipart/form-data": { schema: UploadSkillFileFormSchema } },
		},
	},
	responses: {
		201: {
			description: "Upload a skill archive as a file pending audit",
			content: { "application/json": { schema: ProviderFileInfoSchema } },
		},
		413: {
			description: "Skill archive exceeds the upload size limit",
			content: { "application/json": { schema: ErrorResponseSchema } },
		},
		...errorResponses,
	},
});

skillsRoute.openapi(
	uploadSkillFileRoute,
	async (c) => {
		const { file } = c.req.valid("form");
		if (file.size === 0) return c.json({ error: { message: "file is required" } }, 400);
		if (!file.name.toLowerCase().endsWith(".zip")) {
			return c.json({ error: { message: "skill file must be a .zip" } }, 400);
		}
		if (file.size > MAX_UPLOAD_BYTES) return c.json({ error: { message: "file too large" } }, 413);

		const content = new Uint8Array(await file.arrayBuffer());
		const info = await uploadUserSkillFile({ content, filename: file.name });
		return c.json(info, 201);
	},
	(result, c) => {
		if (!result.success) return c.json({ error: { message: "file is required" } }, 400);
	},
);

const createSkillRoute = createRoute({
	method: "post",
	path: "/skills",
	operationId: "createSkill",
	request: {
		body: {
			required: true,
			content: { "application/json": { schema: CreateSkillBodySchema } },
		},
	},
	responses: {
		201: {
			description: "Create a skill from an audited file",
			content: { "application/json": { schema: ProviderSkillInfoSchema } },
		},
		...errorResponses,
	},
});

skillsRoute.openapi(
	createSkillRoute,
	async (c) => {
		const { fileId } = c.req.valid("json");
		const info = await createUserSkillFromFile(fileId);
		return c.json(info, 201);
	},
	(result, c) => {
		if (!result.success) return c.json({ error: { message: "fileId is required" } }, 400);
	},
);

const warmSkillRoute = createRoute({
	method: "post",
	path: "/skills/warm",
	operationId: "warmSkill",
	request: {
		body: {
			required: true,
			content: { "application/json": { schema: WarmSkillBodySchema } },
		},
	},
	responses: {
		200: {
			description: "Warm a custom skill until it is active",
			content: { "application/json": { schema: WarmSkillResponseSchema } },
		},
		...errorResponses,
	},
});

skillsRoute.openapi(
	warmSkillRoute,
	async (c) => {
		const { name, url } = c.req.valid("json");
		await warmSkillByUrl(name, url);
		return c.json({ ok: true } as const, 200);
	},
	(result, c) => {
		if (!result.success) return c.json({ error: { message: "name and url are required" } }, 400);
	},
);

const listSkillsRoute = createRoute({
	method: "get",
	path: "/skills",
	operationId: "listSkills",
	request: { query: SkillsQuerySchema },
	responses: {
		200: {
			description: "List custom or official skills",
			content: { "application/json": { schema: SkillsResponseSchema } },
		},
		...errorResponses,
	},
});

skillsRoute.openapi(
	listSkillsRoute,
	async (c) => {
		const { source } = c.req.valid("query");
		const skills = await listUserSkills(source);
		return c.json({ skills }, 200);
	},
	(result, c) => {
		if (!result.success) {
			return c.json({ error: { message: "source must be 'custom' or 'official'" } }, 400);
		}
	},
);

const getSkillStatusesRoute = createRoute({
	method: "post",
	path: "/skills/status",
	operationId: "getSkillStatuses",
	request: {
		body: {
			required: true,
			content: { "application/json": { schema: SkillStatusesBodySchema } },
		},
	},
	responses: {
		200: {
			description: "Get skill scan statuses",
			content: { "application/json": { schema: SkillStatusesResponseSchema } },
		},
		...errorResponses,
	},
});

skillsRoute.openapi(
	getSkillStatusesRoute,
	async (c) => {
		const { skillIds } = c.req.valid("json");
		const skills = await getUserSkillStatuses(skillIds);
		return c.json({ skills }, 200);
	},
	(result, c) => {
		if (!result.success) return c.json({ error: { message: "skillIds (string[]) is required" } }, 400);
	},
);

const deleteSkillRoute = createRoute({
	method: "delete",
	path: "/skills/{id}",
	operationId: "deleteSkill",
	request: { params: SkillParamsSchema },
	responses: {
		204: { description: "Skill deleted" },
		...errorResponses,
	},
});

skillsRoute.openapi(deleteSkillRoute, async (c) => {
	const { id } = c.req.valid("param");
	await deleteUserSkill(id);
	return c.body(null, 204);
});
