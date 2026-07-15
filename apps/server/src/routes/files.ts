import { OpenAPIHono } from "@hono/zod-openapi";
import { jsonError } from "@/lib/http-error";
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

/**
 * POST /api/files — multipart/form-data with field `file`. Streams the bytes to the provider's
 * Files API via the SDK and returns the file metadata ({ id, filename, mime_type, size_bytes, created_at }).
 * Plain handler (not zod-openapi) so multipart parsing stays under our control.
 */
filesRoute.post("/files", async (c) => {
	let body: Record<string, unknown>;
	try {
		body = await c.req.parseBody();
	} catch (error) {
		return jsonError(error, 400);
	}
	const file = body.file;
	if (!(file instanceof File) || file.size === 0) {
		return c.json({ error: { message: "file is required" } }, 400);
	}
	if (file.size > MAX_UPLOAD_BYTES) {
		return c.json({ error: { message: "file too large" } }, 413);
	}

	try {
		const content = new Uint8Array(await file.arrayBuffer());
		const info = await uploadUserFile({
			content,
			filename: file.name || "upload",
			mimeType: file.type || undefined,
		});
		return c.json(info, 201);
	} catch (error) {
		return jsonError(error);
	}
});

/**
 * GET /api/files — list workspace user-uploaded files (newest first), as
 * `{ files: [{ id, filename, mime_type, size_bytes, created_at, downloadable, status?, available }] }`.
 * The OpenAPI list omits `status` (@JsonIgnore) but carries `downloadable`; the server enriches
 * `status` + `available` via @openagentpack/sdk/file-lifecycle before responding.
 */
filesRoute.get("/files", async (c) => {
	try {
		const files = await listUserFiles();
		return c.json({ files });
	} catch (error) {
		return jsonError(error);
	}
});

/**
 * POST /api/files/status — body `{ fileIds: string[] }`. Returns each file's normalized scan
 * `status` and bindability (`{ files: [{ id, status, available }] }`).
 */
filesRoute.post("/files/status", async (c) => {
	let body: { fileIds?: unknown };
	try {
		body = await c.req.json();
	} catch (error) {
		return jsonError(error, 400);
	}
	const fileIds = body.fileIds;
	if (!Array.isArray(fileIds) || fileIds.some((id) => typeof id !== "string")) {
		return c.json({ error: { message: "fileIds (string[]) is required" } }, 400);
	}
	try {
		const files = await getUserFileStatuses(fileIds as string[]);
		return c.json({ files });
	} catch (error) {
		return jsonError(error);
	}
});

/**
 * GET /api/files/:id/download — resolves a short-lived presigned download URL for a file
 * (typically an agent-delivered artifact), as `{ url, expires_at }`. The webui fetches this on
 * demand (each click), so the URL never goes stale in the UI. Errors if the provider has no
 * download endpoint (bailian/claude).
 */
filesRoute.get("/files/:id/download", async (c) => {
	const id = c.req.param("id");
	if (!id) {
		return c.json({ error: { message: "file id is required" } }, 400);
	}
	try {
		const result = await getUserFileDownloadUrl(id);
		return c.json(result);
	} catch (error) {
		return jsonError(error);
	}
});

/**
 * DELETE /api/files/:id — removes a previously uploaded file from the provider's Files API.
 * Used when the composer's upload chip is dismissed so the backend doesn't accumulate orphans.
 */
filesRoute.delete("/files/:id", async (c) => {
	const id = c.req.param("id");
	if (!id) {
		return c.json({ error: { message: "file id is required" } }, 400);
	}
	try {
		await deleteUserFile(id);
		return c.body(null, 204);
	} catch (error) {
		return jsonError(error);
	}
});
