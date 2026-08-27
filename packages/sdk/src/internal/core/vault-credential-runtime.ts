import { UserError } from "../errors.ts";
import { computeResourceHash } from "../planner/hasher.ts";
import type { ProviderAdapter } from "../providers/interface.ts";
import type { CredentialDecl, ResolvedProjectConfig } from "../types/config.ts";
import type { VaultCredentialInfo } from "../types/managed-api.ts";
import type { ResourceAddress, ResourceState } from "../types/state.ts";
import type { BackendRuntimeInput, ProjectRuntimeContext } from "./project-runtime.ts";
import { getRuntimeProvider, readProjectRuntime, writeProjectRuntime } from "./project-runtime.ts";
import { planProjectContext } from "./resource-runtime.ts";

export interface VaultCredentialCreateOptions {
	provider?: string;
	refresh?: boolean;
	quiet?: boolean;
	/** Set false only for an offline preview; create always requires the remote duplicate check. */
	checkRemote?: boolean;
}

export interface VaultCredentialCreatePlan {
	provider: string;
	vault: string;
	vaultRemoteId: string;
	credential: string;
	remoteChecked: boolean;
	reuseRemote: boolean;
	remoteCredentialId?: string;
}

export interface VaultCredentialCreateResult extends VaultCredentialCreatePlan {
	credentialId: string;
	adopted: boolean;
}

type VaultCredentialAdapter = Pick<ProviderAdapter, "createCredential" | "listCredentials">;

export async function planVaultCredentialCreate(
	ctx: ProjectRuntimeContext,
	vaultName: string,
	credentialName: string,
	options: VaultCredentialCreateOptions = {},
): Promise<VaultCredentialCreatePlan> {
	const prepared = await prepareVaultCredentialCreate(ctx, vaultName, credentialName, options);
	return {
		provider: prepared.provider,
		vault: vaultName,
		vaultRemoteId: prepared.vaultState.remote_id!,
		credential: credentialName,
		remoteChecked: prepared.remoteChecked,
		reuseRemote: Boolean(prepared.remoteCredential),
		remoteCredentialId: prepared.remoteCredential?.id,
	};
}

export async function planVaultCredentialCreateWithStateBackend(
	input: BackendRuntimeInput,
	vaultName: string,
	credentialName: string,
	options: VaultCredentialCreateOptions = {},
): Promise<VaultCredentialCreatePlan> {
	return readProjectRuntime(input, (ctx) => planVaultCredentialCreate(ctx, vaultName, credentialName, options));
}

export async function createVaultCredential(
	ctx: ProjectRuntimeContext,
	vaultName: string,
	credentialName: string,
	options: VaultCredentialCreateOptions = {},
): Promise<VaultCredentialCreateResult> {
	if (options.checkRemote === false) {
		throw new UserError("Vault Credential create requires the remote duplicate check.");
	}
	const prepared = await prepareVaultCredentialCreate(ctx, vaultName, credentialName, options);
	const remote =
		prepared.remoteCredential ??
		(await prepared.adapter.createCredential!(prepared.vaultState.remote_id!, prepared.credential));
	if (!remote.id) throw new UserError("Credential create returned no remote id.");

	const address: ResourceAddress = { type: "vault", name: vaultName, provider: prepared.provider };
	const desiredHash = await computeResourceHash(address, ctx.config, ctx.configPath, ctx.state);
	ctx.state.setResource({
		...prepared.vaultState,
		content_hash: desiredHash,
		desired_hash: desiredHash,
		drift_paths: [],
		drift_status: "unchecked",
	});
	await ctx.state.save();

	return {
		provider: prepared.provider,
		vault: vaultName,
		vaultRemoteId: prepared.vaultState.remote_id!,
		credential: credentialName,
		remoteChecked: prepared.remoteChecked,
		credentialId: remote.id,
		reuseRemote: Boolean(prepared.remoteCredential),
		remoteCredentialId: prepared.remoteCredential?.id,
		adopted: Boolean(prepared.remoteCredential),
	};
}

export async function createVaultCredentialWithStateBackend(
	input: BackendRuntimeInput,
	vaultName: string,
	credentialName: string,
	options: VaultCredentialCreateOptions = {},
): Promise<VaultCredentialCreateResult> {
	return writeProjectRuntime(input, (ctx) => createVaultCredential(ctx, vaultName, credentialName, options));
}

async function prepareVaultCredentialCreate(
	ctx: ProjectRuntimeContext,
	vaultName: string,
	credentialName: string,
	options: VaultCredentialCreateOptions,
): Promise<{
	provider: string;
	credential: CredentialDecl;
	vaultState: ResourceState;
	adapter: VaultCredentialAdapter;
	remoteChecked: boolean;
	remoteCredential?: VaultCredentialInfo;
}> {
	const vault = ctx.config.vaults?.[vaultName];
	if (!vault) throw new UserError(`Vault '${vaultName}' is not declared in the project config.`);
	const provider = resolveVaultProvider(ctx, vault.provider, options.provider);
	const credential = vault.credentials.at(-1);
	if (!credential || credential.name !== credentialName) {
		throw new UserError(`Credential '${credentialName}' must be the final newly appended entry in vault.${vaultName}.`);
	}
	if (vault.credentials.slice(0, -1).some((entry) => entry.name === credentialName)) {
		throw new UserError(`Vault '${vaultName}' already declares a credential named '${credentialName}'.`);
	}

	const address: ResourceAddress = { type: "vault", name: vaultName, provider };
	const priorConfig = structuredClone(ctx.config) as ResolvedProjectConfig;
	priorConfig.vaults![vaultName] = {
		...priorConfig.vaults![vaultName]!,
		credentials: priorConfig.vaults![vaultName]!.credentials.slice(0, -1),
	};
	const priorPlan = await planProjectContext(
		{ ...ctx, config: priorConfig },
		{
			provider,
			scope: { roots: [address] },
			refresh: options.refresh,
			quiet: options.quiet ?? true,
		},
	);
	const refreshError = priorPlan.refreshResult?.errors[0];
	if (refreshError) {
		throw new UserError(`Cannot verify vault.${vaultName} because refresh failed: ${refreshError.error}`);
	}
	const errorDiagnostic = priorPlan.plan.diagnostics.find((diagnostic) => diagnostic.severity === "error");
	if (errorDiagnostic) throw new UserError(errorDiagnostic.message);
	const vaultAction = priorPlan.plan.actions.find(
		(action) => action.address.type === "vault" && action.address.name === vaultName,
	);
	if (vaultAction?.action !== "no-op") {
		throw new UserError(
			`vault.${vaultName} must be tracked and up-to-date before adding a credential; current action is '${vaultAction?.action ?? "missing"}'.`,
		);
	}
	const vaultState = ctx.state.getResource(address);
	if (!vaultState?.remote_id) throw new UserError(`vault.${vaultName} has no tracked remote id.`);

	const adapter = getRuntimeProvider(ctx, provider);
	if (!adapter.createCredential || !adapter.listCredentials) {
		throw new UserError(`Provider '${provider}' does not support scoped Vault Credential create.`);
	}
	const remoteChecked = options.checkRemote !== false;
	const sameName = remoteChecked
		? (await adapter.listCredentials(vaultState.remote_id)).filter(
				(remoteCredential) => remoteCredential.display_name === credentialName,
			)
		: [];
	const exact = sameName.find((remoteCredential) => credentialMatches(remoteCredential, credential));
	if (sameName.length > 0 && !exact) {
		throw new UserError(`Vault '${vaultName}' already has a different remote credential named '${credentialName}'.`);
	}
	return { provider, credential, vaultState, adapter, remoteChecked, remoteCredential: exact };
}

function resolveVaultProvider(
	ctx: ProjectRuntimeContext,
	declaredProvider: string | undefined,
	requestedProvider: string | undefined,
): string {
	if (requestedProvider && declaredProvider && requestedProvider !== declaredProvider) {
		throw new UserError(
			`Vault provider '${declaredProvider}' does not match requested provider '${requestedProvider}'.`,
		);
	}
	const provider = requestedProvider ?? declaredProvider ?? ctx.config.defaults?.provider;
	if (provider && provider !== "all") return provider;
	const configured = [...ctx.providers.keys()];
	if (configured.length === 1) return configured[0]!;
	throw new UserError("Cannot infer one provider for Vault Credential create.");
}

function credentialMatches(remote: VaultCredentialInfo, desired: CredentialDecl): boolean {
	return (
		remote.auth_type === desired.type &&
		remote.secret_name === desired.secret_name &&
		(remote.networking_type ?? "unrestricted") === (desired.networking?.type ?? "unrestricted")
	);
}
