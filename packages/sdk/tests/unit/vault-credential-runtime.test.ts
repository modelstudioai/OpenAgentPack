import { describe, expect, test } from "bun:test";
import type { ProjectRuntimeContext } from "../../src/internal/core/project-runtime.ts";
import { createVaultCredential, planVaultCredentialCreate } from "../../src/internal/core/vault-credential-runtime.ts";
import { computeResourceHash } from "../../src/internal/planner/hasher.ts";
import { StateManager } from "../../src/internal/state/state-manager.ts";
import type { CredentialDecl, ResolvedProjectConfig } from "../../src/internal/types/config.ts";

const credential: CredentialDecl = {
	name: "api-token",
	type: "environment_variable",
	secret_name: "API_TOKEN",
	secret_value: "super-secret-value",
	networking: { type: "unrestricted" },
	metadata: { owner: "cli" },
};

function candidateConfig(): ResolvedProjectConfig {
	return {
		version: "1",
		providers: { bailian: { api_key: "test", workspace_id: "ws" } },
		defaults: { provider: "bailian" },
		vaults: {
			production: { display_name: "Production", credentials: [credential] },
		},
		_resolved: true,
	};
}

async function makeRuntime(
	options: {
		remoteCredentials?: Array<{
			id: string;
			display_name: string;
			auth_type: string;
			secret_name?: string;
			networking_type?: string;
		}>;
		drifted?: boolean;
	} = {},
) {
	const config = candidateConfig();
	const priorConfig = candidateConfig();
	priorConfig.vaults!.production!.credentials = [];
	const address = { type: "vault" as const, name: "production", provider: "bailian" };
	const priorHash = await computeResourceHash(address, priorConfig);
	const state = StateManager.initialize("/tmp/vault-credential-runtime.json");
	state.setResource({
		address,
		remote_id: "vault_1",
		content_hash: priorHash,
		desired_hash: priorHash,
		drift_status: options.drifted ? "drifted" : "in_sync",
	});
	let createCalls = 0;
	let listCalls = 0;
	const provider = {
		name: "bailian",
		listCredentials: async () => {
			listCalls += 1;
			return options.remoteCredentials ?? [];
		},
		createCredential: async () => {
			createCalls += 1;
			return { id: "credential_1", type: "credential" };
		},
	};
	const runtime = {
		projectName: "test",
		config,
		state,
		providers: new Map([["bailian", provider]]),
	} as unknown as ProjectRuntimeContext;
	return {
		runtime,
		state,
		getCreateCalls: () => createCalls,
		getListCalls: () => listCalls,
	};
}

describe("scoped Vault Credential create", () => {
	test("offline preview does not list remote credentials", async () => {
		const { runtime, getListCalls } = await makeRuntime();
		const result = await planVaultCredentialCreate(runtime, "production", "api-token", {
			refresh: false,
			checkRemote: false,
		});

		expect(result).toMatchObject({ remoteChecked: false, reuseRemote: false });
		expect(getListCalls()).toBe(0);
	});

	test("creates one credential and advances only the parent Vault desired hash", async () => {
		const { runtime, state, getCreateCalls } = await makeRuntime();
		const result = await createVaultCredential(runtime, "production", "api-token", { refresh: false });

		expect(result).toMatchObject({ credentialId: "credential_1", adopted: false, vaultRemoteId: "vault_1" });
		expect(getCreateCalls()).toBe(1);
		const saved = state.getResource({ type: "vault", name: "production", provider: "bailian" })!;
		expect(saved.content_hash).toBe(await computeResourceHash(saved.address, runtime.config, undefined, state));
		expect(JSON.stringify(state.getStateFile())).not.toContain("super-secret-value");
	});

	test("adopts an exact remote retry without creating a duplicate", async () => {
		const { runtime, getCreateCalls } = await makeRuntime({
			remoteCredentials: [
				{
					id: "credential_existing",
					display_name: "api-token",
					auth_type: "environment_variable",
					secret_name: "API_TOKEN",
					networking_type: "unrestricted",
				},
			],
		});
		const result = await createVaultCredential(runtime, "production", "api-token", { refresh: false });

		expect(result).toMatchObject({ credentialId: "credential_existing", adopted: true });
		expect(getCreateCalls()).toBe(0);
	});

	test("blocks Vault drift and conflicting same-name credentials", async () => {
		const drifted = await makeRuntime({ drifted: true });
		await expect(createVaultCredential(drifted.runtime, "production", "api-token", { refresh: false })).rejects.toThrow(
			/must be tracked and up-to-date/,
		);

		const conflicting = await makeRuntime({
			remoteCredentials: [
				{
					id: "credential_other",
					display_name: "api-token",
					auth_type: "environment_variable",
					secret_name: "OTHER_TOKEN",
				},
			],
		});
		await expect(
			createVaultCredential(conflicting.runtime, "production", "api-token", { refresh: false }),
		).rejects.toThrow(/different remote credential/);
	});
});
