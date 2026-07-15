import { stringify as stringifyYaml } from "yaml";
import { UserError } from "../errors.ts";
import { loadConfig } from "../parser/yaml-loader.ts";
import type { ExportedResource } from "../providers/interface.ts";
import { buildProviderFromEnv, placeholderProviderConfig } from "../providers/registry.ts";
import type { ResolvedProjectConfig } from "../types/config.ts";
import type { SkillFile } from "../types/skill-file.ts";
import type { ResourceType } from "../types/state.ts";
import { getRuntimeProvider, type ProjectRuntimeContext } from "./project-runtime.ts";

/**
 * The reverse-export seam: read remote resources back into `agents.yaml` shape.
 * Both methods are optional — only providers that support sync implement them.
 * The wide {@link import("../providers/interface.ts").ProviderAdapter}
 * structurally satisfies it, so provider implementations stay put.
 */
export interface ExportAdapter {
	exportResources?(type: ResourceType): Promise<ExportedResource[]>;
	downloadAllSkillFiles?(): Promise<Map<string, SkillFile[]>>;
}

/** Maps a syncable resource type to its top-level `agents.yaml` group key. */
const SYNCABLE_GROUP: Partial<Record<ResourceType, string>> = {
	environment: "environments",
	vault: "vaults",
	file: "files",
	skill: "skills",
	agent: "agents",
};

export interface SyncProjectOptions {
	/** Provider to read remote resources from (single provider, not "all"). */
	provider: string;
	/** Resource types to export. Defaults to ["vault"]. */
	types?: ResourceType[];
	/** When set, preserve the raw providers block from this config file in output. */
	configPath?: string;
}

export interface SecretPlaceholder {
	vaultName: string;
	credentialName: string;
	envVar: string; // e.g. "VAULT_MIGRATE_DASHSCOPE_API_KEY"
}

export interface SyncProjectResult {
	/** The assembled config object (version + providers + resource groups). */
	config: Record<string, unknown>;
	/** Serialized yaml, aligned with the plan/apply config format. */
	yaml: string;
	/** Count of exported resources per type. */
	counts: Record<string, number>;
	/** Downloaded skill files, keyed by skill name → extracted SkillFile[]. */
	skillFiles?: Map<string, SkillFile[]>;
	/** Vault credential secret placeholders that need user input. */
	secretPlaceholders?: SecretPlaceholder[];
}

/**
 * Pick the provider to sync from when --provider is omitted.
 * Requires an on-disk config with an unambiguous default.
 */
export function resolveSyncProvider(
	config: Pick<ResolvedProjectConfig, "providers" | "defaults">,
	explicitProvider?: string,
): string {
	if (explicitProvider) return explicitProvider;

	const defaultProvider = config.defaults?.provider;
	if (defaultProvider && defaultProvider !== "all") {
		return defaultProvider;
	}

	const providerKeys = Object.keys(config.providers ?? {});
	if (providerKeys.length === 1) {
		return providerKeys[0]!;
	}

	throw new UserError(
		"Cannot determine sync provider. Pass --provider, or set defaults.provider to a single provider (not 'all').",
	);
}

/**
 * Reverse-export a provider's remote resources WITHOUT a `agents.yaml`. The adapter
 * is built from environment variables (e.g. ANTHROPIC_API_KEY), making this the
 * first-run entry point: bootstrap a config from a remote account before any
 * local file exists. The emitted `providers` block uses `${ENV}` placeholders.
 */
export async function syncProviderResourcesFromEnv(opts: SyncProjectOptions): Promise<SyncProjectResult> {
	const adapter = buildProviderFromEnv(opts.provider);
	const providers = await providersBlockFromFile(opts.configPath, opts.provider);
	return assembleSyncedConfig(adapter, opts.provider, {
		types: opts.types,
		version: "1",
		providers,
	});
}

/**
 * Reverse-export using credentials from an existing project config/runtime context.
 */
export async function syncProviderResourcesFromContext(
	ctx: ProjectRuntimeContext,
	opts: SyncProjectOptions,
): Promise<SyncProjectResult> {
	const adapter = getRuntimeProvider(ctx, opts.provider);
	const providers = await providersBlockFromFile(ctx.configPath ?? opts.configPath, opts.provider);
	return assembleSyncedConfig(adapter, opts.provider, {
		types: opts.types,
		version: ctx.config.version ?? "1",
		providers,
	});
}

async function assembleSyncedConfig(
	adapter: ExportAdapter,
	provider: string,
	opts: {
		types?: ResourceType[];
		version?: string;
		providers: Record<string, unknown>;
	},
): Promise<SyncProjectResult> {
	if (!adapter.exportResources) {
		throw new UserError(`Provider '${provider}' does not support sync (no exportResources).`);
	}

	const types = opts.types ?? ["environment", "vault", "file", "skill", "agent"];
	const groups: Record<string, Record<string, unknown>> = {};
	const counts: Record<string, number> = {};

	for (const type of types) {
		const groupKey = SYNCABLE_GROUP[type];
		if (!groupKey) {
			throw new UserError(`Resource type '${type}' is not syncable yet.`);
		}
		const exported = await adapter.exportResources(type);
		let group = groups[groupKey];
		if (!group) {
			group = {};
			groups[groupKey] = group;
		}
		for (const resource of exported) {
			group[resource.name] = { ...resource.decl, provider };
			counts[type] = (counts[type] ?? 0) + 1;
		}
	}

	// Download skill file content if the provider supports it
	let skillFiles: Map<string, SkillFile[]> | undefined;
	if (types.includes("skill") && adapter.downloadAllSkillFiles) {
		skillFiles = await adapter.downloadAllSkillFiles();
	}

	const config: Record<string, unknown> = {
		version: opts.version ?? "1",
		providers: opts.providers,
		...groups,
	};

	// Extract secret placeholders from vault credentials
	const secretPlaceholders = extractSecretPlaceholders(groups.vaults);

	const yaml = stringifyYaml(config, { lineWidth: 0 });
	return { config, yaml, counts, skillFiles, secretPlaceholders };
}

/**
 * Re-read the original (unresolved) providers block from the source file so
 * `${ENV}` placeholders survive; fall back to env-var placeholders otherwise.
 */
async function providersBlockFromFile(
	configPath: string | undefined,
	provider: string,
): Promise<Record<string, unknown>> {
	if (configPath) {
		const { config, errors } = await loadConfig(configPath, false);
		const raw =
			errors.length === 0 ? (config?.providers as Record<string, unknown> | undefined)?.[provider] : undefined;
		if (raw !== undefined) return { [provider]: raw };
	}
	return { [provider]: placeholderProviderConfig(provider) };
}

/** Regex to match `${ENV_VAR_NAME}` placeholders in credential values. */
const PLACEHOLDER_RE = /^\$\{([A-Z_][A-Z0-9_]*)\}$/;

/**
 * Scan the vaults group for credential secret values that are `${...}` placeholders.
 * Returns a list of placeholders the user needs to fill in.
 */
function extractSecretPlaceholders(vaultsGroup: Record<string, unknown> | undefined): SecretPlaceholder[] {
	if (!vaultsGroup) return [];
	const placeholders: SecretPlaceholder[] = [];

	for (const [_key, vaultDecl] of Object.entries(vaultsGroup)) {
		const vault = vaultDecl as Record<string, unknown>;
		const vaultName = (vault.display_name as string) ?? (vault.name as string) ?? _key;
		const credentials = vault.credentials as Array<Record<string, unknown>> | undefined;
		if (!credentials) continue;

		for (const cred of credentials) {
			const credName = (cred.name as string) ?? "unknown";
			// Check access_token (static_bearer) and secret_value (environment_variable)
			for (const field of ["access_token", "secret_value"] as const) {
				const value = cred[field] as string | undefined;
				if (!value) continue;
				const match = PLACEHOLDER_RE.exec(value);
				if (match) {
					placeholders.push({
						vaultName,
						credentialName: credName,
						envVar: match[1]!,
					});
				}
			}
		}
	}

	return placeholders;
}
