import type { DiagnosticCollector } from "../diagnostics/diagnostics.ts";
import type { ProjectConfig } from "../types/config.ts";

/** Qoder and Bailian both cap a coordinator roster at 20 members. */
export const MULTIAGENT_MEMBER_LIMIT = 20;

/**
 * Phase-1 topology rules for `multiagent` rosters: no nested coordinators and no
 * cycles (direct or indirect). Members must be plain worker agents.
 *
 * Diagnostics are emitted in a deterministic order (sorted agent names, roster
 * order preserved within an agent) so output never depends on object traversal
 * order.
 */
export function collectMultiagentTopologyDiagnostics(config: ProjectConfig, diagnostics: DiagnosticCollector): void {
	const agents = config.agents ?? {};
	const names = Object.keys(agents).sort();

	for (const name of names) {
		const decl = agents[name];
		if (!decl?.multiagent) continue;
		for (const member of decl.multiagent.agents) {
			if (typeof member !== "string") continue;
			if (agents[member]?.multiagent) {
				diagnostics.error(
					"config.agent.multiagent.nested",
					`agent.${name}: multiagent member '${member}' is itself a coordinator; nested coordinators are not supported`,
				);
			}
		}
	}

	const state = new Map<string, "visiting" | "done">();
	const path: string[] = [];

	const visit = (name: string): void => {
		if (state.get(name) === "done") return;
		state.set(name, "visiting");
		path.push(name);
		const members = agents[name]?.multiagent?.agents ?? [];
		for (const member of members) {
			if (typeof member !== "string") continue;
			if (!agents[member]) continue;
			if (state.get(member) === "visiting") {
				const cycle = [...path.slice(path.indexOf(member)), member];
				diagnostics.error(
					"config.agent.multiagent.cycle",
					`agent.${name}: multiagent cycle detected: ${cycle.join(" -> ")}`,
				);
				continue;
			}
			visit(member);
		}
		path.pop();
		state.set(name, "done");
	};

	for (const name of names) visit(name);
}
