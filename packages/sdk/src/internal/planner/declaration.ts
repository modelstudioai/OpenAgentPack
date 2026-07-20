import type { ProjectConfig } from "../types/config.ts";
import type { ResourceAddress } from "../types/state.ts";

export function getResourceDeclaration(address: ResourceAddress, config: ProjectConfig): unknown | null {
	const { type, name } = address;
	switch (type) {
		case "environment":
			return config.environments?.[name] ?? null;
		case "vault":
			return config.vaults?.[name] ?? null;
		case "memory_store":
			return config.memory_stores?.[name] ?? null;
		case "skill":
			return config.skills?.[name] ?? null;
		case "agent":
		case "template":
			return config.agents?.[name] ?? null;
		case "file":
			return config.files?.[name] ?? null;
		case "identity":
			return config.identities?.[name] ?? null;
		case "channel":
			return config.channels?.[name] ?? null;
		case "deployment":
			return config.deployments?.[name] ?? null;
		default:
			return null;
	}
}
