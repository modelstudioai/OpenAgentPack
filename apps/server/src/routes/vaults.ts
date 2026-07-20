import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { getVaultProfile } from "@openagentpack/playbooks";
import { createCloudVault, deleteCloudVault, listCloudVaults } from "@openagentpack/sdk";
import { resolveRuntimeProvider } from "@/lib/build-runtime-config";
import { errorResponses } from "@/schemas/common";
import {
	CloudVaultsResponseSchema,
	CreateVaultBodySchema,
	CreateVaultResponseSchema,
	DeleteVaultResponseSchema,
	VaultParamsSchema,
} from "@/schemas/vaults";
import { DEFAULT_AGENT_ID } from "@/services/agents/catalog";
import { withAgentRuntime } from "@/services/runtime-factory";

export const vaultsRoute = new OpenAPIHono();

const listVaultsRoute = createRoute({
	method: "get",
	path: "/vaults",
	responses: {
		200: {
			description: "List raw cloud vaults (the shared credential store resource)",
			content: { "application/json": { schema: CloudVaultsResponseSchema } },
		},
		...errorResponses,
	},
});

// Raw cloud vaults — the shared credential store sessions bind via vault_ids. Not scoped to any
// playbook/agent. The webui session-create gate uses this to detect a missing base vault.
vaultsRoute.openapi(listVaultsRoute, async (c) => {
	const vaults = await withAgentRuntime(DEFAULT_AGENT_ID, (ctx) => listCloudVaults(ctx));
	return c.json({ vaults }, 200);
});

const createVaultRoute = createRoute({
	method: "post",
	path: "/vaults",
	request: {
		body: {
			content: { "application/json": { schema: CreateVaultBodySchema } },
		},
	},
	responses: {
		200: {
			description: "Create a base cloud vault holding the user-supplied DASHSCOPE_API_KEY",
			content: { "application/json": { schema: CreateVaultResponseSchema } },
		},
		...errorResponses,
	},
});

// Provision the base vault when the entry check finds none. The credential structure is
// provider-aware: bailian holds DASHSCOPE_API_KEY (the `bl` CLI's DashScope key). Other providers
// run on managed infra and define NO vault — the route returns the existing vaults (likely none)
// without creating one, so the webui warm flow is a no-op for those providers.
vaultsRoute.openapi(createVaultRoute, async (c) => {
	const { name, metadata, key } = c.req.valid("json");
	const provider = resolveRuntimeProvider();
	const structure = getVaultProfile(provider);
	if (!structure) {
		// No vault to provision for this provider — return a null-id no-op (matches the
		// response schema). The webui warm flow skips this route for such providers.
		return c.json({ id: null, type: "vault_skipped" }, 200);
	}
	const primarySecret = structure.credentials[0]?.secret_name;
	const secretValue = key ?? (primarySecret ? requireEnv(primarySecret) : "");
	const vault = await withAgentRuntime(DEFAULT_AGENT_ID, (ctx) =>
		createCloudVault(ctx, name, {
			// display_name is used as the vault's human-readable label on the provider.
			// findBaseVault identifies the managed vault by its metadata stamp (agents.vault).
			display_name: name,
			metadata,
			credentials: structure.credentials.map((cred) => ({
				name: cred.name,
				type: cred.type,
				secret_name: cred.secret_name,
				secret_value: secretValue,
				networking: cred.networking,
			})),
		}),
	);
	return c.json(vault, 200);
});

const deleteVaultRoute = createRoute({
	method: "delete",
	path: "/vaults/{vaultId}",
	request: {
		params: VaultParamsSchema,
	},
	responses: {
		200: {
			description: "Delete a cloud vault by remote id",
			content: { "application/json": { schema: DeleteVaultResponseSchema } },
		},
		...errorResponses,
	},
});

// Delete the managed base credential vault. The resource center exposes this alongside the
// base environment delete action; active sessions may still be rejected by the provider.
vaultsRoute.openapi(deleteVaultRoute, async (c) => {
	const { vaultId } = c.req.valid("param");
	await withAgentRuntime(DEFAULT_AGENT_ID, (ctx) => deleteCloudVault(ctx, vaultId));
	return c.json({ id: vaultId, type: "vault_deleted" }, 200);
});

function requireEnv(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) {
		throw new Error(`Missing required environment variable '${name}'. Cannot provision the base vault without it.`);
	}
	return value;
}
