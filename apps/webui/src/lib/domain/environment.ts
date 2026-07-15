import type { CloudEnvironment } from "@openagentpack/sdk";
import { createApiEnvironment, deleteApiEnvironment, getApiEnvironments } from "../api/client";
import { formatApiErrorMessage } from "../api/error-message";
import { resolveStampedResource } from "../resolve-stamped";

// Identity of the shared base environment. Mirrors the cloud-agent scheme (Agents/ name
// prefix + a metadata stamp): the name nets it, the stamp re-confirms it's ours and not
// a user-created environment that merely shares the name. Both are fixed (one base env).
const BASE_ENVIRONMENT_NAME = "Agents/base";
const BASE_ENVIRONMENT_METADATA_KEY = "agents.base";
const BASE_ENVIRONMENT_METADATA_VALUE = "true";
const BASE_ENVIRONMENT_METADATA: Record<string, string> = {
	[BASE_ENVIRONMENT_METADATA_KEY]: BASE_ENVIRONMENT_METADATA_VALUE,
};

/**
 * Lookup of the managed base environment via the stamp `agents.base === "true"`.
 * Name is intentionally NOT part of the identity: provider-side name normalization
 * (e.g. Ark's lowercase/charset constraints) can rewrite `Agents/base`.
 * If duplicates carry the stamp, the most recently updated one wins.
 */
export function findBaseEnvironment(environments: CloudEnvironment[]): CloudEnvironment | undefined {
	return resolveStampedResource(environments, {
		matches: (env) => env.metadata?.[BASE_ENVIRONMENT_METADATA_KEY] === BASE_ENVIRONMENT_METADATA_VALUE,
		updatedAt: (env) => env.updated_at,
	}).winner;
}

/** Read all (active) cloud environments — the shared base sandbox resource. */
export async function fetchEnvironments(): Promise<CloudEnvironment[]> {
	const res = await getApiEnvironments();
	if (res.error) throw new Error(formatApiErrorMessage(res.error, "读取运行环境失败"));
	return res.data?.environments ?? [];
}

/**
 * Resolve the remote id of the managed base environment a session must run in. Throws when
 * it doesn't exist — a session cannot be created without a sandbox. The entry check
 * (warmWorkspace) provisions it; this is the hard gate at create time.
 */
export async function resolveBaseEnvironmentId(): Promise<string> {
	const id = findBaseEnvironment(await fetchEnvironments())?.id;
	if (!id) {
		throw new Error(`未检测到运行环境(沙箱),无法创建任务。请先创建默认环境「${BASE_ENVIRONMENT_NAME}」。`);
	}
	return id;
}

/** Delete a cloud environment by remote id — the resource center's destructive base-sandbox action. */
export async function deleteEnvironment(environmentId: string): Promise<void> {
	const res = await deleteApiEnvironment({ path: { environmentId } });
	if (res.error) throw new Error(formatApiErrorMessage(res.error, "删除运行环境失败"));
}

/**
 * Create the managed base environment (name `Agents/base` + stamp `agents.base`). The cloud config
 * (packages, networking) is single-sourced server-side from the playbooks catalog. Throws on
 * failure. Called by the unified base-resources entry check; not a standalone gate.
 */
export async function createBaseEnvironment(): Promise<void> {
	const created = await createApiEnvironment({
		body: { name: BASE_ENVIRONMENT_NAME, metadata: BASE_ENVIRONMENT_METADATA },
	});
	if (created.error) throw new Error(formatApiErrorMessage(created.error, "创建运行环境失败"));
}
