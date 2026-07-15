import { UserError } from "../errors.ts";
import type { ProviderCapabilities } from "../providers/capabilities.ts";
import type { ModelInfo } from "../providers/interface.ts";
import { allProviders } from "../providers/registry.ts";
import "../providers/all.ts";

export interface ProviderModelInfo {
	id: string;
	display_name: string;
	source: string;
	is_enabled: boolean;
	is_new: boolean;
	price_factor?: number;
	efforts?: string[];
	default_effort?: string;
}

export interface ProviderModelListing {
	provider: string;
	supportsDynamicListing: boolean;
	models: ProviderModelInfo[];
}

export interface ProviderDiscoveryEntry {
	name: string;
	capabilities: ProviderCapabilities;
}

/**
 * The model-listing seam: enumerate a provider's available models. Optional —
 * only providers with dynamic model discovery implement it. The wide
 * {@link import("../providers/interface.ts").ProviderAdapter} structurally satisfies it.
 */
export interface ModelListAdapter {
	listModels?(): Promise<ModelInfo[]>;
}

/**
 * Context-first entry point: list models from a pre-built providers Map.
 * No file I/O is performed — the caller supplies the provider adapters.
 */
export async function listProviderModelsForContext(
	providers: ReadonlyMap<string, ModelListAdapter>,
	providerFilter?: string,
): Promise<ProviderModelListing[]> {
	const targetProviders = providerFilter ? [providerFilter] : Array.from(providers.keys());
	const result: ProviderModelListing[] = [];

	for (const name of targetProviders) {
		const adapter = providers.get(name);
		if (!adapter) {
			throw new UserError(`Provider '${name}' is not configured.`);
		}
		if (!adapter.listModels) {
			result.push({
				provider: name,
				supportsDynamicListing: false,
				models: [],
			});
			continue;
		}
		result.push({
			provider: name,
			supportsDynamicListing: true,
			models: await adapter.listModels(),
		});
	}

	return result;
}

export function listProviderNames(): string[] {
	return listProviderDiscovery().map((provider) => provider.name);
}

export function listProviderDiscovery(): ProviderDiscoveryEntry[] {
	return allProviders()
		.map((provider) => ({
			name: provider.name,
			capabilities: provider.capabilities,
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
}
