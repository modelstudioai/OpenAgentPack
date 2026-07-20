import { z } from "@hono/zod-openapi";
import { CloudVaultSchema } from "@openagentpack/sdk";

export { CloudVaultSchema } from "@openagentpack/sdk";

export const CloudVaultsResponseSchema = z.object({
	vaults: z.array(CloudVaultSchema),
});

export const CreateVaultBodySchema = z.object({
	name: z.string().min(1),
	metadata: z.record(z.string(), z.string()).optional(),
	// The DASHSCOPE_API_KEY stored as the vault's credential secret value. Optional:
	// when omitted the server injects it from its own DASHSCOPE_API_KEY env.
	key: z.string().min(1).optional(),
});

export const CreateVaultResponseSchema = z.object({
	id: z.string().nullable(),
	type: z.string(),
	version: z.number().optional(),
});

export const DeleteVaultResponseSchema = z.object({
	id: z.string(),
	type: z.string(),
});

export const VaultParamsSchema = z.object({
	vaultId: z.string().min(1),
});
