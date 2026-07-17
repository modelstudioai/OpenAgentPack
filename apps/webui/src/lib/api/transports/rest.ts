import type {
	ApiResult,
	ApiTransport,
	CreateSkillFromFileOptions,
	FileStatusInfo,
	SkillSummary,
	SkillUploadResult,
	UploadedFile,
} from "../contract";
import { formatApiErrorMessage } from "../error-message";
import type { HttpMethod, WirePath, WireRequestOptions, WireResponse } from "../generated/wire";

// The server enriches `status` + `available` via @openagentpack/sdk/file-lifecycle before JSON serialization.
type WireFile = WireResponse<"GET", "/api/files">["files"][number];

function isFileStatus(value: string | undefined): value is NonNullable<UploadedFile["status"]> {
	return value === "available" || value === "checking" || value === "rejected" || value === "type_rejected";
}

// Map the generated wire shape onto the UI's narrower file lifecycle interface.
function toUploadedFile(file: WireFile): UploadedFile {
	return {
		id: file.id,
		filename: file.filename,
		mime_type: file.mime_type,
		size_bytes: file.size_bytes,
		created_at: file.created_at,
		status: isFileStatus(file.status) ? file.status : undefined,
		available: file.available,
	};
}

async function discardResponse<T>(promise: Promise<ApiResult<T>>): Promise<ApiResult<void>> {
	const result = await promise;
	return result.error ? { error: result.error } : {};
}

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

export async function request<M extends HttpMethod, P extends WirePath<M>>(
	method: M,
	template: P,
	options: WireRequestOptions<M, P> = {},
): Promise<ApiResult<WireResponse<M, P>>> {
	let path: string = template;
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
	return { data: parsed as WireResponse<M, P> };
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
	return { data: toUploadedFile(parsed as WireResponse<"POST", "/api/files">) };
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
		discardResponse(request("DELETE", "/api/sessions/{sessionId}", { path: options.path, query: options.query })),
	listAgents: (options = {}) => request("GET", "/api/cloud-agents", { query: options.query }),
	listModels: () => request("GET", "/api/models"),
	archiveAgent: (options) =>
		discardResponse(request("POST", "/api/cloud-agents/{agentId}/archive", { path: options.path })),
	updateAgent: (options) =>
		discardResponse(request("POST", "/api/cloud-agents/{agentId}", { path: options.path, body: options.body })),
	warmSkill: (options) => discardResponse(request("POST", "/api/skills/warm", { body: options.body })),
	listEnvironments: () => request("GET", "/api/environments"),
	async createEnvironment(options) {
		const result = await request("POST", "/api/environments", { body: options.body });
		return result.error ? { error: result.error } : { data: result.data?.environment };
	},
	deleteEnvironment: (options) =>
		discardResponse(request("DELETE", "/api/environments/{environmentId}", { path: options.path })),
	listVaults: () => request("GET", "/api/vaults"),
	createVault: (options) => request("POST", "/api/vaults", { body: options.body }),
	deleteVault: (options) => discardResponse(request("DELETE", "/api/vaults/{vaultId}", { path: options.path })),
	uploadFile: (options) => uploadFileRest(options.body.file),
	async listFiles() {
		const res = await request("GET", "/api/files");
		if (res.error || !res.data) return res as ApiResult<{ files: UploadedFile[] }>;
		return { data: { files: res.data.files.map(toUploadedFile) } };
	},
	async getFileStatuses(options) {
		const result = await request("POST", "/api/files/status", { body: options.body });
		if (result.error || !result.data) return result as ApiResult<{ files: FileStatusInfo[] }>;
		return {
			data: {
				files: result.data.files.map((file) => ({
					...file,
					status: isFileStatus(file.status) ? file.status : undefined,
				})),
			},
		};
	},
	getFileDownload: (options) => request("GET", "/api/files/{id}/download", { path: { id: options.path.fileId } }),
	deleteFile: (options) => discardResponse(request("DELETE", "/api/files/{id}", { path: { id: options.path.fileId } })),
	uploadSkill: (options) => uploadSkillRest(options.body.file),
	createSkillFromFile: (options) => createSkillFromFileRest(options),
	listSkills: (options = {}) => request("GET", "/api/skills", { query: options.query }),
	getSkillStatuses: (options) => request("POST", "/api/skills/status", { body: options.body }),
	deleteSkill: (options) =>
		discardResponse(request("DELETE", "/api/skills/{id}", { path: { id: options.path.skillId } })),
	getConfig: () => request("GET", "/api/config"),
	getConfigReady: () => request("GET", "/api/config/ready"),
	saveConfig: (options) => request("PUT", "/api/config", { body: options.body }),
};
