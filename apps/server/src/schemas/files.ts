import { z } from "@hono/zod-openapi";

export const ProviderFileInfoSchema = z
	.object({
		id: z.string(),
		filename: z.string(),
		mime_type: z.string(),
		size_bytes: z.number(),
		created_at: z.string(),
		downloadable: z.boolean().optional(),
		status: z.string().optional(),
		purpose: z.string().optional(),
		available: z.boolean().optional(),
	})
	.openapi("ProviderFileInfo");

export const UploadFileFormSchema = z.object({
	file: z.instanceof(File).openapi({ type: "string", format: "binary" }),
});

export const FilesResponseSchema = z.object({
	files: z.array(ProviderFileInfoSchema),
});

export const FileStatusesBodySchema = z.object({
	fileIds: z.array(z.string()),
});

export const FileStatusInfoSchema = z.object({
	id: z.string(),
	status: z.string().optional(),
	available: z.boolean().optional(),
});

export const FileStatusesResponseSchema = z.object({
	files: z.array(FileStatusInfoSchema),
});

export const FileParamsSchema = z.object({
	id: z.string().min(1),
});

export const FileDownloadResponseSchema = z.object({
	url: z.string(),
	expires_at: z.string().optional(),
});
