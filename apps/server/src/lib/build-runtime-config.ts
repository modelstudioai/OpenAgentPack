import { getEnvironmentProfile, getVaultProfile } from "@openagentpack/playbooks";
import {
	type LoadedProjectConfig,
	resolveProjectConfigFromObject,
	resolveProviderConfigFromEnv,
} from "@openagentpack/sdk";

// Local state-scope anchor only (deriveWebUiStateScope reads this directly). NOT passed as the
// config projectName — that's "" so the bailian provider emits no agents.* stamp (a `bl`-only marker).
export const RUNTIME_PROJECT_NAME = "bailian-cli";

/** Deployment-level provider switch. One provider per server deployment; defaults to bailian. */
export function resolveRuntimeProvider(): string {
	return process.env.AGENTS_PROVIDER?.trim() || "bailian";
}

/**
 * Assemble the server's runtime project config in memory from environment credentials
 * + the shared playbooks catalog (environment + vault structure), then validate it through
 * the SDK's object-level resolution. No demo/example agents.yaml is read at runtime.
 *
 * The provider is selected by AGENTS_PROVIDER (default bailian). Its config block is
 * resolved from env via the SDK's central provider→env mapping so the var list lives in
 * one place (the registry) rather than being duplicated here.
 */
export async function buildRuntimeConfig(providerOverride?: string): Promise<LoadedProjectConfig> {
	const provider = providerOverride?.trim() || resolveRuntimeProvider();
	const providerConfig = resolveProviderConfigFromEnv(provider);

	const environment = getEnvironmentProfile(provider);
	const vault = getVaultProfile(provider);

	// Every provider provisions a cloud sandbox environment; bailian additionally installs
	// `bailian-cli` in it. The vault is provider-conditional: bailian holds its DASHSCOPE_API_KEY;
	// other providers currently define no vault.
	//
	// Metadata stamps (`agents.base` / `agents.vault`) let the webui identify managed base
	// resources via remote listing (findBaseEnvironment / findBaseVault), complementing the
	// state-tracked identity the plan/apply engine provides.
	const vaults = vault
		? {
				[vault.name]: {
					display_name: vault.display_name,
					credentials: vault.credentials.map((cred) => ({
						name: cred.name,
						type: cred.type,
						secret_name: cred.secret_name,
						// Secret value is injected from env here — never stored in playbooks.
						secret_value: requireEnv(cred.secret_name),
						...(cred.networking ? { networking: cred.networking } : {}),
					})),
					metadata: { "agents.vault": "true" },
				},
			}
		: {};
	const environments = {
		[environment.name]: {
			...(environment.description ? { description: environment.description } : {}),
			config: environment.config,
			metadata: { "agents.base": "true" },
		},
	};

	const rawConfig = {
		version: "1",
		providers: {
			[provider]: providerConfig,
		},
		defaults: { provider },
		vaults,
		environments,
	};

	// projectName "" so the bailian provider stamps NO agents.project/agents.resource: those mark
	// `bl` CLI deploys only. Server agents carry app_id + playbook_id (the App identity, written
	// by both transports). Local state scope stays anchored on RUNTIME_PROJECT_NAME via
	// deriveWebUiStateScope (it reads the constant directly, decoupled from config.projectName).
	return resolveProjectConfigFromObject(rawConfig, { projectName: "" });
}

function requireEnv(name: string): string {
	const value = process.env[name]?.trim();
	if (!value) {
		throw new Error(
			`Missing required environment variable '${name}'. The server assembles its runtime config from env + playbooks and no longer reads a agents.yaml file.`,
		);
	}
	return value;
}
