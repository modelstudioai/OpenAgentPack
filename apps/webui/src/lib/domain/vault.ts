import type { CloudVault } from "@openagentpack/sdk";
import { createApiVault, deleteApiVault, getApiVaults } from "../api/client";
import { formatApiErrorMessage } from "../api/error-message";
import { resolveStampedResource } from "../resolve-stamped";

// Identity of the shared base vault — the credential store holding the user-supplied
// DASHSCOPE_API_KEY. Identity relies on the metadata stamp alone (not display_name) because
// the engine and the imperative warm path may create vaults with different display_name values
// ("Cli Secrets" vs "Agents/secrets"), but both always set the `agents.vault` stamp.
const BASE_VAULT_NAME = "Agents/secrets";
const BASE_VAULT_METADATA_KEY = "agents.vault";
const BASE_VAULT_METADATA_VALUE = "true";
const BASE_VAULT_METADATA: Record<string, string> = {
	[BASE_VAULT_METADATA_KEY]: BASE_VAULT_METADATA_VALUE,
};

/**
 * Identity lookup of the managed base vault via the metadata stamp
 * `agents.vault === "true"`. The stamp is set both by the engine (plan/apply)
 * and by the legacy imperative create path, so it is the universal identity
 * signal regardless of how the vault was provisioned. On duplicates the most
 * recently updated stamped vault wins.
 */
export function findBaseVault(vaults: CloudVault[]): CloudVault | undefined {
	return resolveStampedResource(vaults, {
		matches: (vault) => vault.metadata?.[BASE_VAULT_METADATA_KEY] === BASE_VAULT_METADATA_VALUE,
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
