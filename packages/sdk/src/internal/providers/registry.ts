import type { z } from "zod";
import { UserError } from "../errors.ts";
import type { ResourceKind } from "./capabilities.ts";
import { isSupported, type ProviderCapabilities, REQUIRED_METHODS_BY_KIND } from "./capabilities.ts";
import type { ProviderAdapter } from "./interface.ts";

export interface ProviderDefinition {
	name: string;
	configSchema: z.ZodType<unknown>;
	capabilities: ProviderCapabilities;
	createAdapter(config: unknown, projectName?: string): ProviderAdapter;
}

const registry = new Map<string, ProviderDefinition>();

export function registerProvider(def: ProviderDefinition): void {
	registry.set(def.name, def);
}

/**
 * Assert that an adapter implements every method required by the facets its
 * capability matrix declares supported (tier `native`/`emulated`). The matrix is
 * the single source of truth: an unsupported kind requires no methods, so
 * providers need no throw-stubs for what they don't support. Fails fast, naming
 * the provider, kind, and missing method.
 */
export function validateProviderFacets(def: ProviderDefinition, adapter: ProviderAdapter): void {
	const missing: string[] = [];
	for (const [kind, methods] of Object.entries(REQUIRED_METHODS_BY_KIND)) {
		if (!isSupported(def.capabilities, kind as ResourceKind)) continue;
		for (const method of methods) {
			if (typeof (adapter as unknown as Record<string, unknown>)[method] !== "function") {
				missing.push(`${kind}.${method}`);
			}
		}
	}
	if (missing.length > 0) {
		throw new UserError(
			`Provider '${def.name}' declares support for capabilities whose adapter methods are missing: ${missing.join(", ")}. ` +
				`Either implement the method or mark the capability tier 'unsupported'.`,
		);
	}
}

export function getProvider(name: string): ProviderDefinition | undefined {
	return registry.get(name);
}

export function allProviders(): ProviderDefinition[] {
	return Array.from(registry.values());
}

export function buildProviders(
	providersConfig: Record<string, unknown>,
	projectName?: string,
): Map<string, ProviderAdapter> {
	const adapters = new Map<string, ProviderAdapter>();

	for (const [name, rawConfig] of Object.entries(providersConfig)) {
		const def = registry.get(name);
		if (!def) {
			throw new UserError(`Unknown provider '${name}'. Registered: ${Array.from(registry.keys()).join(", ")}`);
		}
		const parsed = def.configSchema.parse(rawConfig);
		const adapter = def.createAdapter(parsed, projectName);
		validateProviderFacets(def, adapter);
		adapters.set(name, adapter);
	}

	return adapters;
}

/**
 * Environment variable mappings for each provider.
 * Used to construct a provider adapter without a agents.yaml config file.
 */
const PROVIDER_ENV_VARS: Record<string, Record<string, { env: string[]; required: boolean }>> = {
	bailian: {
		api_key: { env: ["DASHSCOPE_API_KEY", "BAILIAN_API_KEY"], required: true },
		workspace_id: { env: ["BAILIAN_WORKSPACE_ID"], required: true },
		base_url: { env: ["BAILIAN_BASE_URL"], required: false },
	},
	qoder: {
		api_key: { env: ["QODER_PAT", "QODER_API_KEY"], required: true },
		gateway: { env: ["QODER_GATEWAY"], required: false },
	},
	claude: {
		api_key: { env: ["ANTHROPIC_API_KEY", "CLAUDE_API_KEY"], required: true },
		beta: { env: ["CLAUDE_BETA"], required: false },
	},
	ark: {
		api_key: { env: ["ARK_API_KEY"], required: true },
	},
};

/**
 * Build a `providers` config block for a single provider using `${ENV}`
 * placeholders for its required fields. Used by `agents sync` to emit a providers
 * block without leaking resolved secrets when the original file is unavailable.
 */
export function placeholderProviderConfig(providerName: string): Record<string, string> {
	const envMap = PROVIDER_ENV_VARS[providerName];
	if (!envMap) return {};
	const out: Record<string, string> = {};
	for (const [field, { env, required }] of Object.entries(envMap)) {
		if (required && env[0]) out[field] = `\${${env[0]}}`;
	}
	return out;
}

/**
 * Resolve a provider's config block from environment variables (actual values, not
 * `${ENV}` placeholders). Throws when a required field's env var is unset. Used both
 * by `buildProviderFromEnv` and by servers that assemble a raw project config object
 * (e.g. the server) and feed it through `resolveProjectConfigFromObject`.
 */
export function resolveProviderConfigFromEnv(providerName: string): Record<string, string> {
	const envMap = PROVIDER_ENV_VARS[providerName];
	if (!envMap) {
		throw new UserError(`Provider '${providerName}' does not support env-var-based initialization.`);
	}

	const config: Record<string, string> = {};
	const missing: string[] = [];

	for (const [field, { env, required }] of Object.entries(envMap)) {
		let value: string | undefined;
		for (const varName of env) {
			value = process.env[varName];
			if (value) break;
		}
		if (value) {
			config[field] = value;
		} else if (required) {
			missing.push(env.join(" or "));
		}
	}

	if (missing.length > 0) {
		throw new UserError(
			`Cannot initialize provider '${providerName}' from environment.\n` +
				`Missing required env vars: ${missing.join(", ")}\n` +
				`Either provide a agents.yaml config file or set the required environment variables.`,
		);
	}

	return config;
}

/**
 * Build a single provider adapter using environment variables.
 * Falls back to env vars when no agents.yaml is available.
 */
export function buildProviderFromEnv(providerName: string, projectName?: string): ProviderAdapter {
	const def = registry.get(providerName);
	if (!def) {
		throw new UserError(`Unknown provider '${providerName}'. Registered: ${Array.from(registry.keys()).join(", ")}`);
	}

	const config = resolveProviderConfigFromEnv(providerName);
	const parsed = def.configSchema.parse(config);
	const adapter = def.createAdapter(parsed, projectName);
	validateProviderFacets(def, adapter);
	return adapter;
}
