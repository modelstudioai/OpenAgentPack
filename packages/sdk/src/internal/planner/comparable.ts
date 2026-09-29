import { resolveAgentRefs, resolveTemplateRefs } from "../executor/resolver.ts";
import type { ResolvedAgentRefs, ResolvedTemplateRefs } from "../providers/interface.ts";
import type { DriftReadAdapter } from "../providers/resource-workflow.ts";
import type { IStateManager } from "../state/state-manager.ts";
import type { ProjectConfig } from "../types/config.ts";
import type { ResourceAddress } from "../types/state.ts";
import { contentHash } from "../utils/hash.ts";
import { getResourceDeclaration } from "./declaration.ts";

export function resolveComparableRefs(
	address: ResourceAddress,
	config: ProjectConfig | undefined,
	state: IStateManager | undefined,
): ResolvedAgentRefs | ResolvedTemplateRefs | undefined {
	if (!state || !config) return undefined;
	if (address.type === "agent") return resolveAgentRefs(address.name, config, address.provider, state);
	if (address.type === "template") return resolveTemplateRefs(address.name, config, address.provider, state);
	return undefined;
}

export function computeComparableDesiredHash(
	address: ResourceAddress,
	config: ProjectConfig,
	provider: Pick<DriftReadAdapter, "normalizeDesiredResource">,
	state?: IStateManager,
): string | undefined {
	const decl = getResourceDeclaration(address, config);
	if (!decl || !provider.normalizeDesiredResource) return undefined;
	const refs = resolveComparableRefs(address, config, state);
	const comparable = provider.normalizeDesiredResource(address.type, address.name, decl, refs);
	return comparable === null ? undefined : contentHash(comparable);
}
