import { describe, expect, test } from "bun:test";
import type { ProjectRuntimeContext } from "../../src/internal/core/project-runtime.ts";
import { createVaultCredential, planVaultCredentialCreate } from "../../src/internal/core/vault-credential-runtime.ts";
import { computeResourceHash } from "../../src/internal/planner/hasher.ts";
import { StateManager } from "../../src/internal/state/state-manager.ts";
import type { CredentialDecl, ResolvedProjectConfig } from "../../src/internal/types/config.ts";
import type { VaultCredentialInfo } from "../../src/internal/types/managed-api.ts";

const credential: CredentialDecl = {
	name: "api-token",
	type: "environment_variable",
	secret_name: "API_TOKEN",
	secret_value: "super-secret-value",
	networking: { type: "unrestricted" },
	metadata: { owner: "cli" },
};

function candidateConfig(providerName = "bailian"): ResolvedProjectConfig {
	return {
		version: "1",
		providers: { [providerName]: { api_key: "test", workspace_id: "ws" } },
		defaults: { provider: providerName },
		vaults: {
			production: { display_name: "Production", credentials: [credential] },
		},
		_resolved: true,
	};
}

async function makeRuntime(
	options: { remoteCredentials?: VaultCredentialInfo[]; drifted?: boolean; provider?: string } = {},
) {
	const providerName = options.provider ?? "bailian";
	const config = candidateConfig(providerName);
	const priorConfig = candidateConfig(providerName);
	priorConfig.vaults!.production!.credentials = [];
	const address = { type: "vault" as const, name: "production", provider: providerName };
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
		name: providerName,
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
		providers: new Map([[providerName, provider]]),
	} as unknown as ProjectRuntimeContext;
	return {
		runtime,
		state,
		getCreateCalls: () => createCalls,
		getListCalls: () => listCalls,
	};
}

describe("scoped Vault Credential create", () => {
	test.each(["claude", "qoder", "ark"])("preserves legacy limited-policy adoption for %s", async (provider) => {
		const { runtime, getCreateCalls } = await makeRuntime({
			provider,
			remoteCredentials: [
				{
					id: "credential_existing",
					display_name: credential.name,
					auth_type: credential.type,
					secret_name: credential.secret_name,
					networking_type: "limited",
					metadata: credential.metadata,
				},
			],
		});
		runtime.config.vaults!.production!.credentials = [{ ...credential, networking: { type: "limited" } }];
		const result = await createVaultCredential(runtime, "production", "api-token", { refresh: false });
		expect(result.adopted).toBe(true);
		expect(getCreateCalls()).toBe(0);
	});

	test.each(["claude", "qoder", "ark"])("rejects Bailian-only fields before remote calls for %s", async (provider) => {
		for (const policy of [
			{ networking: { type: "limited" as const, allowed_hosts: ["api.example.com"] } },
			{ injection_location: { header: true, body: false } },
		]) {
			const { runtime, getCreateCalls, getListCalls } = await makeRuntime({ provider });
			runtime.config.vaults!.production!.credentials = [{ ...credential, ...policy }];
			await expect(createVaultCredential(runtime, "production", "api-token", { refresh: false })).rejects.toThrow(
				/only supported by bailian/,
			);
			expect(getListCalls()).toBe(0);
			expect(getCreateCalls()).toBe(0);
		}
	});

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
					metadata: { owner: "cli" },
				},
			],
		});
		const result = await createVaultCredential(runtime, "production", "api-token", { refresh: false });

		expect(result).toMatchObject({ credentialId: "credential_existing", adopted: true });
		expect(getCreateCalls()).toBe(0);
	});

	test("rejects a same-name remote credential when metadata differs", async () => {
		const { runtime, getCreateCalls } = await makeRuntime({
			remoteCredentials: [
				{
					id: "credential_existing",
					display_name: "api-token",
					auth_type: "environment_variable",
					secret_name: "API_TOKEN",
					networking_type: "unrestricted",
					metadata: { owner: "someone-else" },
				},
			],
		});

		await expect(createVaultCredential(runtime, "production", "api-token", { refresh: false })).rejects.toThrow(
			/different remote credential/,
		);
		expect(getCreateCalls()).toBe(0);
	});

	test("adopts a matching host policy regardless of host order", async () => {
		const { runtime, getCreateCalls } = await makeRuntime({
			remoteCredentials: [
				{
					id: "credential_existing",
					display_name: credential.name,
					auth_type: credential.type,
					secret_name: credential.secret_name,
					metadata: credential.metadata,
					networking: { type: "limited", allowed_hosts: ["*.example.org", "api.example.com"] },
					injection_location: { header: true, body: false },
				},
			],
		});
		runtime.config.vaults!.production!.credentials = [
			{
				...credential,
				networking: { allowed_hosts: ["api.example.com", "*.example.org"] },
				injection_location: { header: true, body: false },
			},
		];
		const result = await createVaultCredential(runtime, "production", "api-token", { refresh: false });
		expect(result.adopted).toBe(true);
		expect(getCreateCalls()).toBe(0);
	});

	test.each([
		{ networking: { allowed_hosts: ["*"] }, injection_location: { header: true, body: false } },
		{ networking: { allowed_hosts: ["other.example.com"] }, injection_location: { header: true, body: false } },
		{ networking: { allowed_hosts: ["api.example.com"] }, injection_location: { header: true, body: true } },
		{ networking: { allowed_hosts: ["api.example.com"] }, injection_location: { header: false, body: true } },
		{ networking: { allowed_hosts: ["api.example.com"] } },
	])("rejects a same-name credential with different or unknown policy: %j", async (policy) => {
		const { runtime, getCreateCalls } = await makeRuntime({
			remoteCredentials: [
				{
					id: "credential_existing",
					display_name: credential.name,
					auth_type: credential.type,
					secret_name: credential.secret_name,
					metadata: credential.metadata,
					...policy,
				},
			],
		});
		runtime.config.vaults!.production!.credentials = [
			{
				...credential,
				networking: { allowed_hosts: ["api.example.com"] },
				injection_location: { header: true, body: false },
			},
		];
		await expect(createVaultCredential(runtime, "production", "api-token", { refresh: false })).rejects.toThrow(
			/different remote credential/,
		);
		expect(getCreateCalls()).toBe(0);
	});

	test("rejects Bailian static_bearer before checking or mutating the remote vault", async () => {
		const { runtime, getCreateCalls, getListCalls } = await makeRuntime();
		runtime.config.vaults!.production!.credentials = [
			{
				name: "api-token",
				type: "static_bearer",
				mcp_server_url: "https://mcp.example.com",
				access_token: "secret",
			},
		];

		await expect(planVaultCredentialCreate(runtime, "production", "api-token", { refresh: false })).rejects.toThrow(
			/Bailian only supports 'environment_variable'/,
		);
		expect(getListCalls()).toBe(0);
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
