import {
	deleteApiFile,
	type FileStatusInfo,
	getApiFileDownload,
	getApiFileStatuses,
	listApiFiles,
	type UploadedFile,
	uploadApiFile,
} from "../api/client";
import { formatApiErrorMessage } from "../api/error-message";

export type { FileStatusInfo, UploadedFile };

// Project isolation has no server-side support: neither wire carries file metadata/labels
// (verified against bailian-app-control). So we encode ownership into the stored filename —
// every Agents upload is named `Agents__<original>`. The list filters by this prefix; display
// names and mount paths strip it, so the sandbox/user only ever see the clean original name.
const AGENTS_FILE_PREFIX = "Agents__";

export function hasPrefix(name: string): boolean {
	return name.startsWith(AGENTS_FILE_PREFIX);
}

function applyPrefix(name: string): string {
	return hasPrefix(name) ? name : `${AGENTS_FILE_PREFIX}${name}`;
}

export function stripPrefix(name: string): string {
	return hasPrefix(name) ? name.slice(AGENTS_FILE_PREFIX.length) : name;
}

/**
 * Upload a single file through the REST transport (→ server → provider Files API).
 * The file is renamed to `Agents__<name>` before upload so the project-isolation prefix lands in the
 * provider's real stored filename — list/display/mount all key off it.
 */
export async function uploadFile(file: File): Promise<UploadedFile> {
	const named = hasPrefix(file.name) ? file : new File([file], applyPrefix(file.name), { type: file.type });
	const { data, error } = await uploadApiFile({ body: { file: named } });
	if (error) throw new Error(formatApiErrorMessage(error, "上传失败"));
	if (!data) throw new Error("上传失败");
	return data;
}

/**
 * List the project's uploaded files. The `Agents__` prefix is filtered client-side
 * (the OpenAPI list has no project-keyword filter). Returns files with the prefix intact —
 * callers strip it for display via stripPrefix.
 */
export async function listFiles(limit?: number): Promise<UploadedFile[]> {
	const { data, error } = await listApiFiles({ query: { limit } });
	if (error) throw new Error(formatApiErrorMessage(error, "获取文件列表失败"));
	return (data?.files ?? []).filter((f) => hasPrefix(f.filename));
}

/** Delete a previously uploaded file by its backend id. */
export async function deleteFile(fileId: string): Promise<void> {
	const { error } = await deleteApiFile({ path: { fileId } });
	if (error) throw new Error(formatApiErrorMessage(error, "删除失败"));
}

/**
 * Resolve a short-lived presigned download URL for a file (typically an agent-delivered artifact).
 * Fetched on demand per click so the URL never goes stale. Routes through the server to the
 * provider's GET /files/{id}/content.
 */
export async function getFileDownloadUrl(fileId: string): Promise<string> {
	const { data, error } = await getApiFileDownload({ path: { fileId } });
	if (error) throw new Error(formatApiErrorMessage(error, "获取下载链接失败"));
	if (!data?.url) throw new Error("获取下载链接失败");
	return data.url;
}

/**
 * Fetch the provider scan `status` for a batch of uploaded files. The composer polls this to gate
 * session binding on `available` (the provider rejects files still in `checking`).
 */
export async function getFileStatuses(fileIds: string[]): Promise<FileStatusInfo[]> {
	if (fileIds.length === 0) return [];
	const { data, error } = await getApiFileStatuses({ body: { fileIds } });
	if (error) throw new Error(formatApiErrorMessage(error, "查询文件状态失败"));
	return data?.files ?? [];
}
