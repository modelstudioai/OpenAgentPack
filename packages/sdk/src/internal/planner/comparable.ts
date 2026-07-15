import type { DriftReadAdapter } from "../providers/resource-workflow.ts";
import type { ProjectConfig } from "../types/config.ts";
import type { ResourceAddress } from "../types/state.ts";
import { contentHash } from "../utils/hash.ts";
import { getResourceDeclaration } from "./declaration.ts";

export function computeComparableDesiredHash(
	address: ResourceAddress,
	config: ProjectConfig,
	provider: Pick<DriftReadAdapter, "normalizeDesiredResource">,
): string | undefined {
	const decl = getResourceDeclaration(address, config);
	if (!decl || !provider.normalizeDesiredResource) return undefined;
	const comparable = provider.normalizeDesiredResource(address.type, address.name, decl);
	return comparable === null ? undefined : contentHash(comparable);
}
