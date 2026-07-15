import {
	createApiSession,
	deleteApiSession,
	getApiConfig,
	getApiSession,
	listApiSessionEvents,
	type SessionDetail,
	type SessionEventsPage,
	sendApiSessionMessage,
} from "../api/client";
import { formatApiErrorMessage } from "../api/error-message";
import { DEFAULT_PLAYBOOK_PROVIDER, getVaultProfile } from "../playbooks";
import { resolveBaseEnvironmentId } from "./environment";
import { resolveBaseVaultId } from "./vault";

export type { SessionDetail, SessionEventsPage };

export async function fetchSession(sessionId: string, agentId?: string): Promise<SessionDetail> {
	const { data, error } = await getApiSession({ path: { sessionId }, query: { agentId } });
	if (error) throw new Error(apiErrorMessage(error));
	if (!data) throw new Error("请求失败");
	return data;
}

export async function fetchSessionEventsPage(
	sessionId: string,
	pageToken: string,
	agentId?: string,
): Promise<SessionEventsPage> {
	const { data, error } = await listApiSessionEvents({
		path: { sessionId },
		query: { agentId, pageToken },
	});
	if (error) throw new Error(apiErrorMessage(error));
	if (!data) throw new Error("请求失败");
	return data;
}

async function resolveProvider(): Promise<string> {
	const res = await getApiConfig();
	return res.data?.AGENTS_PROVIDER || DEFAULT_PLAYBOOK_PROVIDER;
}

export async function createSessionFromPrompt(
	prompt: string,
	agentId: string,
	options: { title?: string; files?: { fileId: string; mountPath: string }[]; model?: string } = {},
): Promise<SessionDetail> {
	// A session always binds a cloud sandbox (environment); bailian also binds its credential
	// vault (DASHSCOPE_API_KEY). The vault is optional — providers that need no credential store
	// (currently all non-bailian) skip it.
	const environmentId = await resolveBaseEnvironmentId();
	const provider = await resolveProvider();
	const needsVault = !!getVaultProfile(provider);
	const vaultId = needsVault ? await resolveBaseVaultId() : undefined;
	const vaultIds = vaultId ? [vaultId] : undefined;
	const { data, error } = await createApiSession({
		body: {
			agentId,
			prompt,
			environmentId,
			vaultIds,
			title: options.title,
			files: options.files,
			model: options.model,
		},
	});
	if (error) throw new Error(apiErrorMessage(error));
	if (!data) throw new Error("请求失败");
	return data;
}

export async function sendSessionMessage(sessionId: string, message: string, agentId?: string): Promise<SessionDetail> {
	const { data, error } = await sendApiSessionMessage({ path: { sessionId }, body: { agentId, message } });
	if (error) throw new Error(apiErrorMessage(error));
	if (!data) throw new Error("请求失败");
	return data;
}

export async function deleteSession(sessionId: string, agentId?: string): Promise<void> {
	const { error } = await deleteApiSession({ path: { sessionId }, query: { agentId } });
	if (error) throw new Error(apiErrorMessage(error));
}

function apiErrorMessage(error: unknown): string {
	return formatApiErrorMessage(error, "请求失败");
}
