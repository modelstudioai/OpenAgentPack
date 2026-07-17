import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { ErrorResponseSchema, errorResponses } from "@/schemas/common";
import {
	FileDownloadResponseSchema,
	FileParamsSchema,
	FileStatusesBodySchema,
	FileStatusesResponseSchema,
	FilesResponseSchema,
	ProviderFileInfoSchema,
	UploadFileFormSchema,
} from "@/schemas/files";
import {
	deleteUserFile,
	getUserFileDownloadUrl,
	getUserFileStatuses,
	listUserFiles,
	uploadUserFile,
} from "@/services/files/upload";

export const filesRoute = new OpenAPIHono();

// Max upload size enforced at the edge (the provider also caps via nacos cmaMaxFileSize).
const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

const uploadFileRoute = createRoute({
	method: "post",
	path: "/files",
	operationId: "uploadFile",
	request: {
		body: {
			required: true,
			content: { "multipart/form-data": { schema: UploadFileFormSchema } },
		},
	},
	responses: {
		201: {
			description: "Upload a workspace file",
			content: { "application/json": { schema: ProviderFileInfoSchema } },
		},
		413: {
			description: "File exceeds the upload size limit",
			content: { "application/json": { schema: ErrorResponseSchema } },
		},
		...errorResponses,
	},
});

filesRoute.openapi(
	uploadFileRoute,
	async (c) => {
		const { file } = c.req.valid("form");
		if (file.size === 0) {
			return c.json({ error: { message: "file is required" } }, 400);
		}
		if (file.size > MAX_UPLOAD_BYTES) {
			return c.json({ error: { message: "file too large" } }, 413);
		}

		const content = new Uint8Array(await file.arrayBuffer());
		const info = await uploadUserFile({
			content,
			filename: file.name || "upload",
			mimeType: file.type || undefined,
		});
		return c.json(info, 201);
	},
	(result, c) => {
		if (!result.success) return c.json({ error: { message: "file is required" } }, 400);
	},
);

const listFilesRoute = createRoute({
	method: "get",
	path: "/files",
	operationId: "listFiles",
	responses: {
		200: {
			description: "List workspace files",
			content: { "application/json": { schema: FilesResponseSchema } },
		},
		...errorResponses,
	},
});

filesRoute.openapi(listFilesRoute, async (c) => {
	const files = await listUserFiles();
	return c.json({ files }, 200);
});

const getFileStatusesRoute = createRoute({
	method: "post",
	path: "/files/status",
	operationId: "getFileStatuses",
	request: {
		body: {
			required: true,
			content: { "application/json": { schema: FileStatusesBodySchema } },
		},
	},
	responses: {
		200: {
			description: "Get file scan statuses",
			content: { "application/json": { schema: FileStatusesResponseSchema } },
		},
		...errorResponses,
	},
});

filesRoute.openapi(
	getFileStatusesRoute,
	async (c) => {
		const { fileIds } = c.req.valid("json");
		const files = await getUserFileStatuses(fileIds);
		return c.json({ files }, 200);
	},
	(result, c) => {
		if (!result.success) return c.json({ error: { message: "fileIds (string[]) is required" } }, 400);
	},
);

const downloadFileRoute = createRoute({
	method: "get",
	path: "/files/{id}/download",
	operationId: "downloadFile",
	request: { params: FileParamsSchema },
	responses: {
		200: {
			description: "Resolve a short-lived file download URL",
			content: { "application/json": { schema: FileDownloadResponseSchema } },
		},
		...errorResponses,
	},
});

filesRoute.openapi(downloadFileRoute, async (c) => {
	const { id } = c.req.valid("param");
	const result = await getUserFileDownloadUrl(id);
	return c.json(result, 200);
});

const deleteFileRoute = createRoute({
	method: "delete",
	path: "/files/{id}",
	operationId: "deleteFile",
	request: { params: FileParamsSchema },
	responses: {
		204: { description: "File deleted" },
		...errorResponses,
	},
});

filesRoute.openapi(deleteFileRoute, async (c) => {
	const { id } = c.req.valid("param");
	await deleteUserFile(id);
	return c.body(null, 204);
});
