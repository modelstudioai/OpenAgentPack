import type { AgentDecl } from "../types/config.ts";

export interface AgentMaterialization {
	resourceType: "agent" | "template";
	mode: "managed" | "forward";
}

/**
 * Resolve the physical provider resource represented by a logical `agents.*`
 * declaration. This is the single seam for delivery-mode decisions: graph,
 * state, planner, executor, and runtime callers must not re-derive it.
 */
export function resolveAgentMaterialization(provider: string, agent: AgentDecl): AgentMaterialization {
	const mode = agent.delivery?.[provider]?.type ?? "managed";
	if (mode === "managed") return { resourceType: "agent", mode };
	return { resourceType: "template", mode };
}
