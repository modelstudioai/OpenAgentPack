import {
	deleteFile,
	getAgent,
	getFileDownloadUrl,
	getFileInfo,
	listFiles,
	type ProviderFileInfo,
	uploadFile,
} from "@openagentpack/sdk";
import { DEFAULT_AGENT_ID } from "@/services/agents/catalog";
import { withAgentRuntime } from "@/services/runtime-factory";

/**
 * Upload raw file bytes to the resolved provider's Files API (app-control /api/v1/agentstudio/files
 * via the SDK provider). Files are workspace-scoped user uploads, so they resolve through the default
 * agent's provider rather than being tied to a session.
 */
export async function uploadUserFile(input: {
	content: Uint8Array;
	filename: string;
	mimeType?: string;
}): Promise<ProviderFileInfo> {
	return withAgentRuntime(DEFAULT_AGENT_ID, async (ctx, compiled) => {
		const provider = getAgent(ctx, compiled.agentId).provider;
		return uploadFile(ctx, input.content, input.filename, { provider, mimeType: input.mimeType });
	});
}

/** Delete a previously uploaded user file by id from the resolved provider's Files API. */
export async function deleteUserFile(id: string): Promise<void> {
	return withAgentRuntime(DEFAULT_AGENT_ID, async (ctx, compiled) => {
		const provider = getAgent(ctx, compiled.agentId).provider;
		await deleteFile(ctx, id, { provider });
	});
}

/**
 * List workspace user-uploaded files (newest first). Project isolation (filename prefix) is applied
 * by the webui domain layer, not here — this returns the provider's raw user-upload list.
 */
export async function listUserFiles(): Promise<ProviderFileInfo[]> {
	return withAgentRuntime(DEFAULT_AGENT_ID, async (ctx, compiled) => {
		const provider = getAgent(ctx, compiled.agentId).provider;
		return listFiles(ctx, { provider });
	});
}

/**
 * Resolve a short-lived presigned download URL for a file (e.g. an agent-delivered artifact).
 * Throws when the resolved provider has no download endpoint (bailian/claude).
 */
export async function getUserFileDownloadUrl(id: string): Promise<{ url: string; expires_at?: string }> {
	return withAgentRuntime(DEFAULT_AGENT_ID, async (ctx, compiled) => {
		const provider = getAgent(ctx, compiled.agentId).provider;
		return getFileDownloadUrl(ctx, id, { provider });
	});
}

/**
 * Fetch scan `status` and bindability for a batch of uploaded files. The composer polls this to gate
 * session binding on `available`. Missing/failed lookups surface as `status: undefined` so the
 * caller keeps polling rather than hard-failing.
 */
export async function getUserFileStatuses(
	fileIds: string[],
): Promise<{ id: string; status?: string; available?: boolean }[]> {
	return withAgentRuntime(DEFAULT_AGENT_ID, async (ctx, compiled) => {
		const provider = getAgent(ctx, compiled.agentId).provider;
		return Promise.all(
			fileIds.map(async (id) => {
				try {
					const info = await getFileInfo(ctx, id, { provider });
					return { id, status: info.status, available: info.available };
				} catch {
					return { id, status: undefined, available: undefined };
				}
			}),
		);
	});
}
