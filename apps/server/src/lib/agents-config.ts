import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
	AGENTS_CONFIG_PROVIDERS,
	AGENTS_PROVIDER_FIELDS,
	applyProviderConfigToEnv,
	type ProviderConfig,
	type ProviderConfigProvider,
	providerConfigPath,
	resolveActiveProvider,
} from "@openagentpack/sdk";

export {
	AGENTS_CONFIG_PROVIDERS,
	AGENTS_PROVIDER_FIELDS,
	type ProviderConfig,
	type ProviderConfigProvider,
	providerConfigPath,
} from "@openagentpack/sdk";

function isProvider(value: string): value is ProviderConfigProvider {
	return (AGENTS_CONFIG_PROVIDERS as readonly string[]).includes(value);
}

function parseProviderConfigSnapshot(raw: string): Partial<ProviderConfig> {
	const parsed = JSON.parse(raw) as Record<string, unknown>;
	const providerRaw = typeof parsed.AGENTS_PROVIDER === "string" ? parsed.AGENTS_PROVIDER : undefined;
	const provider = providerRaw?.trim();
	if (!provider || !isProvider(provider)) {
		return {};
	}
	const config: Partial<ProviderConfig> = { AGENTS_PROVIDER: provider };
	for (const field of AGENTS_PROVIDER_FIELDS[provider]) {
		const value = parsed[field.key];
		if (typeof value === "string" && value.trim()) {
			config[field.key] = value.trim();
		}
	}
	return config;
}

export function validateProviderConfig(input: Record<string, unknown>): ProviderConfig {
	const providerRaw = typeof input.AGENTS_PROVIDER === "string" ? input.AGENTS_PROVIDER : undefined;
	if (typeof providerRaw !== "string" || !isProvider(providerRaw.trim())) {
		throw new Error(`AGENTS_PROVIDER must be one of: ${AGENTS_CONFIG_PROVIDERS.join(", ")}`);
	}
	const provider = providerRaw.trim() as ProviderConfigProvider;
	const config: ProviderConfig = { AGENTS_PROVIDER: provider };

	const missing: string[] = [];
	for (const field of AGENTS_PROVIDER_FIELDS[provider]) {
		const raw = input[field.key];
		const value = typeof raw === "string" ? raw.trim() : "";
		if (!value) {
			missing.push(field.key);
			continue;
		}
		config[field.key] = value;
	}
	if (missing.length > 0) {
		throw new Error(`Missing required fields for provider '${provider}': ${missing.join(", ")}`);
	}
	return config;
}

/**
 * Read the effective provider config visible to the WebUI settings dialog.
 *
 * Sources (highest to lowest priority):
 * 1. `~/.agents/config.json` (or `AGENTS_CONFIG_PATH`)
 * 2. `process.env` (which already includes `.env` loaded by the server bootstrap)
 *
 * The disk file may contain only a provider selection; missing fields for every
 * provider are backfilled from the running process environment so users can
 * switch providers in the settings dialog without manually copying `.env`.
 */
export async function readProviderConfig(): Promise<Partial<ProviderConfig>> {
	const path = providerConfigPath();
	let diskConfig: Partial<ProviderConfig> = {};
	try {
		const raw = await readFile(path, "utf8");
		diskConfig = parseProviderConfigSnapshot(raw);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			diskConfig = {};
		} else if (error instanceof SyntaxError) {
			throw new Error(`Invalid JSON in ${path}`);
		} else {
			throw error;
		}
	}

	const provider: ProviderConfigProvider = diskConfig.AGENTS_PROVIDER ?? resolveActiveProvider();
	const merged: Partial<ProviderConfig> = { AGENTS_PROVIDER: provider };
	for (const candidateProvider of AGENTS_CONFIG_PROVIDERS) {
		for (const field of AGENTS_PROVIDER_FIELDS[candidateProvider]) {
			const diskValue = diskConfig[field.key]?.trim();
			const envValue = process.env[field.key]?.trim();
			const value = diskValue || envValue;
			if (value) merged[field.key] = value;
		}
	}
	return merged;
}

export async function writeProviderConfig(input: Record<string, unknown>): Promise<ProviderConfig> {
	const config = validateProviderConfig(input);
	const path = providerConfigPath();
	await mkdir(dirname(path), { recursive: true });

	const payload: ProviderConfig = { AGENTS_PROVIDER: config.AGENTS_PROVIDER };
	for (const field of AGENTS_PROVIDER_FIELDS[config.AGENTS_PROVIDER]) {
		payload[field.key] = config[field.key]!;
	}
	await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
	applyProviderConfigToEnv(payload, { force: true });
	return payload;
}

export {
	applyProviderConfigToEnv,
	bootstrapRuntimeCredentials,
	bootstrapRuntimeCredentialsSync,
	loadDotEnv,
	loadProviderConfigIntoEnv,
	loadProviderConfigIntoEnvSync,
} from "@openagentpack/sdk";
