import type { CloudVault } from "@openagentpack/sdk";
import { createApiVault, deleteApiVault, getApiVaults } from "../api/client";
import { formatApiErrorMessage } from "../api/error-message";
import { resolveStampedResource } from "../resolve-stamped";

// Identity of the shared base vault — the credential store holding the user-supplied
// DASHSCOPE_API_KEY. Mirrors the base-environment scheme (Agents/ name prefix + a metadata
// stamp): a vault has no `name` field, so identity rides on `display_name` + the stamp.
const BASE_VAULT_NAME = "Agents/secrets";
const BASE_VAULT_METADATA_KEY = "agents.vault";
const BASE_VAULT_METADATA_VALUE = "true";
const BASE_VAULT_METADATA: Record<string, string> = {
	[BASE_VAULT_METADATA_KEY]: BASE_VAULT_METADATA_VALUE,
};

/**
 * Two-layer lookup of the managed base vault (mirrors `findBaseEnvironment`): layer 1 nets
 * by `display_name === "Agents/secrets"`; layer 2 re-confirms our stamp `agents.vault === "true"`.
 * A display-name match WITHOUT the stamp is a foreign vault and is ignored. On duplicates,
 * the most recently updated stamped vault wins.
 */
export function findBaseVault(vaults: CloudVault[]): CloudVault | undefined {
	return resolveStampedResource(vaults, {
		matches: (vault) =>
			vault.display_name === BASE_VAULT_NAME && vault.metadata?.[BASE_VAULT_METADATA_KEY] === BASE_VAULT_METADATA_VALUE,
		updatedAt: (vault) => vault.updated_at,
	}).winner;
}

/** Read all (active) cloud vaults — the shared credential store. */
export async function fetchVaults(): Promise<CloudVault[]> {
	const res = await getApiVaults();
	if (res.error) throw new Error(formatApiErrorMessage(res.error, "读取密钥库失败"));
	return res.data?.vaults ?? [];
}

/**
 * Resolve the remote id of the managed base vault a session binds. Find-or-throw (mirrors
 * `resolveBaseEnvironmentId`): the vault is provisioned up front by the base-resources entry
 * check, so at session-create time it must already exist. Throwing on miss is the hard gate —
 * a session can't bind a sandbox credential that isn't there.
 */
export async function resolveBaseVaultId(): Promise<string> {
	const id = findBaseVault(await fetchVaults())?.id;
	if (!id) {
		throw new Error(`未检测到密钥库,无法创建任务。请先创建默认密钥库「${BASE_VAULT_NAME}」。`);
	}
	return id;
}

/**
 * Create the managed base vault (display_name `Agents/secrets` + stamp `agents.vault`) holding the
 * DASHSCOPE_API_KEY. The server injects the key from its own env, so `key` is omitted. Throws on
 * failure. Called by the unified base-resources entry check; not a standalone gate.
 */
export async function createBaseVault(key?: string): Promise<string> {
	const created = await createApiVault({
		body: { name: BASE_VAULT_NAME, metadata: BASE_VAULT_METADATA, ...(key ? { key } : {}) },
	});
	if (created.error) throw new Error(formatApiErrorMessage(created.error, "创建密钥库失败"));
	const id = created.data?.id;
	if (!id) throw new Error("创建密钥库失败");
	return id;
}

/** Delete a cloud vault by remote id — the resource center's destructive base-vault action. */
export async function deleteVault(vaultId: string): Promise<void> {
	const { error } = await deleteApiVault({ path: { vaultId } });
	if (error) throw new Error(formatApiErrorMessage(error, "删除密钥库失败"));
}
