import type {
	ApiResult,
	ApiTransport,
	CreateSkillFromFileOptions,
	SkillSummary,
	SkillUploadResult,
	UploadedFile,
} from "../contract";
import { formatApiErrorMessage } from "../error-message";

// The server enriches `status` + `available` via @openagentpack/sdk/file-lifecycle before JSON serialization.
// Strip the wire-only `downloadable` field so the public contract stays clean.
function stripDownloadable(file: UploadedFile & { downloadable?: boolean }): UploadedFile {
	const { downloadable: _downloadable, ...rest } = file;
	return rest;
}

type RequestOptions = {
	path?: Record<string, string>;
	query?: Record<string, unknown>;
	body?: unknown;
};

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

export async function request<T>(
	method: string,
	template: string,
	options: RequestOptions = {},
): Promise<ApiResult<T>> {
	let path = template;
	if (options.path) {
		for (const [key, value] of Object.entries(options.path)) {
			path = path.replace(`{${key}}`, encodeURIComponent(value));
		}
	}

	const params = new URLSearchParams();
	if (options.query) {
		for (const [key, value] of Object.entries(options.query)) {
			if (value !== undefined && value !== null) params.append(key, String(value));
		}
	}
	const queryString = params.toString();
	const url = `${path}${queryString ? `?${queryString}` : ""}`;

	const init: RequestInit = { method, cache: "no-store" };
	if (options.body !== undefined) {
		init.headers = { "Content-Type": "application/json" };
		init.body = JSON.stringify(options.body);
	}

	let response: Response;
	try {
		response = await fetch(url, init);
	} catch (error) {
		return {
			error: {
				error: {
					message: formatApiErrorMessage(error, "网络请求失败，请检查网络连接"),
				},
			},
		};
	}

	const text = await response.text();
	const parsed = text ? safeJson(text) : undefined;

	if (!response.ok) {
		const message = formatApiErrorMessage(parsed, `HTTP ${response.status}`);
		return { error: { error: { message } } };
	}
	return { data: parsed as T };
}

async function uploadFileRest(file: File): Promise<ApiResult<UploadedFile>> {
	const formData = new FormData();
	formData.append("file", file);
	let response: Response;
	try {
		// No explicit Content-Type: the browser sets multipart/form-data with the boundary.
		response = await fetch("/api/files", { method: "POST", body: formData, cache: "no-store" });
	} catch (error) {
		return { error: { error: { message: formatApiErrorMessage(error, "网络请求失败，请检查网络连接") } } };
	}
	const text = await response.text();
	const parsed = text ? safeJson(text) : undefined;
	if (!response.ok) {
		return { error: { error: { message: formatApiErrorMessage(parsed, `HTTP ${response.status}`) } } };
	}
	return { data: stripDownloadable(parsed as UploadedFile & { downloadable?: boolean }) };
}

// Phase 1: upload the zip and return a pending handle. The file must clear content audit
// (status `available`) first. The UI polls file status, then calls createSkillFromFile to
// create the skill record in phase 2.
async function uploadSkillRest(file: File): Promise<ApiResult<SkillUploadResult>> {
	const formData = new FormData();
	formData.append("file", file);
	let response: Response;
	try {
		response = await fetch("/api/skills/upload-file", { method: "POST", body: formData, cache: "no-store" });
	} catch (error) {
		return { error: { error: { message: formatApiErrorMessage(error, "网络请求失败，请检查网络连接") } } };
	}
	const text = await response.text();
	const parsed = text ? safeJson(text) : undefined;
	if (!response.ok) {
		return { error: { error: { message: formatApiErrorMessage(parsed, `HTTP ${response.status}`) } } };
	}
	const fileInfo = parsed as { id: string; filename?: string };
	return { data: { kind: "pending", fileId: fileInfo.id, filename: fileInfo.filename ?? file.name } };
}

// Phase 2: create the skill from the now-available file.
function createSkillFromFileRest(options: CreateSkillFromFileOptions): Promise<ApiResult<SkillSummary>> {
	return request("POST", "/api/skills", { body: options.body });
}

export const restTransport: ApiTransport = {
	listSessions: (options = {}) => request("GET", "/api/sessions", { query: options.query }),
	createSession: (options) => request("POST", "/api/sessions", { body: options.body }),
	getSession: (options) => request("GET", "/api/sessions/{sessionId}", { path: options.path, query: options.query }),
	listSessionEvents: (options) =>
		request("GET", "/api/sessions/{sessionId}/events", { path: options.path, query: options.query }),
	sendSessionMessage: (options) =>
		request("POST", "/api/sessions/{sessionId}/messages", {
			path: options.path,
			body: options.body,
		}),
	deleteSession: (options) =>
		request("DELETE", "/api/sessions/{sessionId}", { path: options.path, query: options.query }),
	listAgents: (options = {}) => request("GET", "/api/cloud-agents", { query: options.query }),
	listModels: () => request("GET", "/api/models"),
	archiveAgent: (options) => request("POST", "/api/cloud-agents/{agentId}/archive", { path: options.path }),
	updateAgent: (options) => request("POST", "/api/cloud-agents/{agentId}", { path: options.path, body: options.body }),
	warmSkill: (options) => request("POST", "/api/skills/warm", { body: options.body }),
	listEnvironments: () => request("GET", "/api/environments"),
	createEnvironment: (options) => request("POST", "/api/environments", { body: options.body }),
	deleteEnvironment: (options) => request("DELETE", "/api/environments/{environmentId}", { path: options.path }),
	listVaults: () => request("GET", "/api/vaults"),
	createVault: (options) => request("POST", "/api/vaults", { body: options.body }),
	deleteVault: (options) => request("DELETE", "/api/vaults/{vaultId}", { path: options.path }),
	uploadFile: (options) => uploadFileRest(options.body.file),
	async listFiles(options = {}) {
		const res = await request<{ files: (UploadedFile & { downloadable?: boolean })[] }>("GET", "/api/files", {
			query: options.query,
		});
		if (res.error || !res.data) return res as ApiResult<{ files: UploadedFile[] }>;
		return { data: { files: res.data.files.map(stripDownloadable) } };
	},
	getFileStatuses: (options) => request("POST", "/api/files/status", { body: options.body }),
	getFileDownload: (options) => request("GET", "/api/files/{fileId}/download", { path: options.path }),
	deleteFile: (options) => request("DELETE", "/api/files/{fileId}", { path: options.path }),
	uploadSkill: (options) => uploadSkillRest(options.body.file),
	createSkillFromFile: (options) => createSkillFromFileRest(options),
	listSkills: (options = {}) => request("GET", "/api/skills", { query: options.query }),
	getSkillStatuses: (options) => request("POST", "/api/skills/status", { body: options.body }),
	deleteSkill: (options) => request("DELETE", "/api/skills/{skillId}", { path: options.path }),
	getConfig: () => request("GET", "/api/config"),
	getConfigReady: () => request("GET", "/api/config/ready"),
	saveConfig: (options) => request("PUT", "/api/config", { body: options.body }),
};
