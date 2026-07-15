import { getApiConfig, getApiConfigReady, saveApiConfig } from "@/lib/api/client";
import type { AgentsConfig, AgentsConfigProvider, AgentsConfigSnapshot } from "@/lib/api/contract";
import { AGENTS_CONFIG_PROVIDERS, AGENTS_PROVIDER_FIELDS } from "@/lib/api/contract";

export type { AgentsConfig, AgentsConfigProvider, AgentsConfigSnapshot, AgentsProviderField } from "@/lib/api/contract";
export { AGENTS_CONFIG_PROVIDERS, AGENTS_PROVIDER_FIELDS } from "@/lib/api/contract";

export async function loadAgentsConfig(): Promise<AgentsConfigSnapshot | null> {
	const res = await getApiConfig();
	if (res.error || !res.data) return null;
	return res.data;
}

export async function loadAgentsConfigReady(): Promise<boolean> {
	const res = await getApiConfigReady();
	if (res.error || !res.data) return false;
	return res.data.ready;
}

export async function persistAgentsConfig(
	config: AgentsConfig,
): Promise<{ ok: true; config: AgentsConfig } | { ok: false; message: string }> {
	const res = await saveApiConfig({ body: config });
	if (res.error) {
		return { ok: false, message: res.error.error?.message ?? "保存配置失败" };
	}
	if (!res.data) return { ok: false, message: "保存配置失败" };
	return { ok: true, config: res.data };
}

export function providerFields(provider: AgentsConfigProvider) {
	return AGENTS_PROVIDER_FIELDS[provider];
}

export function isAgentsConfigComplete(config: AgentsConfig): boolean {
	return providerFields(config.AGENTS_PROVIDER).every((field) => config[field.key]?.trim());
}

export function isAgentsConfigSnapshotComplete(config: AgentsConfigSnapshot | null | undefined): boolean {
	if (!config?.AGENTS_PROVIDER) return false;
	if (!(AGENTS_CONFIG_PROVIDERS as readonly string[]).includes(config.AGENTS_PROVIDER)) return false;
	return providerFields(config.AGENTS_PROVIDER).every((field) => config[field.key]?.trim());
}

export async function resolveActivePlaybookProvider(): Promise<AgentsConfigProvider> {
	const config = await loadAgentsConfig();
	if (config?.AGENTS_PROVIDER && (AGENTS_CONFIG_PROVIDERS as readonly string[]).includes(config.AGENTS_PROVIDER)) {
		return config.AGENTS_PROVIDER;
	}
	return "bailian";
}
