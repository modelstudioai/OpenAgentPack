import type { ResolvedMultiagentRoster } from "./model.ts";

export interface ComparableMultiagentRoster {
	type: "coordinator";
	member_ids: string[];
}

export type MultiagentMaterialization = "managed" | "forward";

export type CanonicalRemoteRoster = { supported: true; roster?: ComparableMultiagentRoster } | { supported: false };

export function canonicalizeDesiredRoster(
	resolved: ResolvedMultiagentRoster | undefined,
): ComparableMultiagentRoster | undefined {
	if (!resolved) return undefined;
	const memberIds = [...new Set(resolved.members.map((member) => member.remote_id))].sort();
	return { type: "coordinator", member_ids: memberIds };
}

export function canonicalizeRemoteRoster(
	raw: unknown,
	materialization: MultiagentMaterialization,
): CanonicalRemoteRoster {
	if (raw === null || raw === undefined) return { supported: true };
	if (typeof raw !== "object") return { supported: false };
	const roster = raw as { type?: unknown; agents?: unknown };
	if (roster.type !== "coordinator") return { supported: false };
	if (!Array.isArray(roster.agents)) return { supported: false };
	if (roster.agents.length === 0) return { supported: true };

	const memberIds: string[] = [];
	for (const entry of roster.agents) {
		if (typeof entry !== "object" || entry === null) return { supported: false };
		const member = entry as { type?: unknown; id?: unknown; template_id?: unknown };
		// `self` and advisor members are deliberately rejected: Phase 1 cannot
		// declare them, so treating them as ordinary agents would silently hide
		// a remote roster this project can never converge to.
		if (member.type !== "agent") return { supported: false };
		const id = materialization === "forward" ? member.template_id : member.id;
		if (typeof id !== "string") return { supported: false };
		memberIds.push(id);
	}
	return { supported: true, roster: { type: "coordinator", member_ids: [...new Set(memberIds)].sort() } };
}

/**
 * Canonical `multiagent` value for a comparable body: the roster when present,
 * undefined when there is none, and a sentinel no desired canonicalization can
 * produce when the remote carries members Phase 1 cannot represent.
 */
export function comparableMultiagentField(
	raw: unknown,
	materialization: MultiagentMaterialization,
): ComparableMultiagentRoster | { type: "unsupported" } | undefined {
	const canonical = canonicalizeRemoteRoster(raw, materialization);
	if (!canonical.supported) return { type: "unsupported" };
	return canonical.roster;
}
