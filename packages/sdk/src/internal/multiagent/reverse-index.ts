import { UserError } from "../errors.ts";
import type { MultiagentMemberDecl } from "../types/config.ts";

/** One `/agents` listing entry, keyed by remote agent id. */
export interface ReverseIndexEntry {
	/** Logical name from `agents.resource` metadata; only set when `agents.project` matches this project. */
	logical_name?: string;
	archived: boolean;
	owned: boolean;
}

export type ReverseIndex = Map<string, ReverseIndexEntry>;

/**
 * Index the full `/agents` listing (archived entries included) by remote id.
 * `logical_name` comes only from an explicitly present `agents.resource` whose
 * `agents.project` matches — display names and ids are never used as fallbacks,
 * so an agent without managed metadata simply has no logical name.
 */
export function buildReverseIndex(agents: Array<Record<string, unknown>>, project: string): ReverseIndex {
	const index: ReverseIndex = new Map();
	for (const raw of agents) {
		const id = raw.id;
		if (typeof id !== "string") continue;
		const metadata = raw.metadata as Record<string, unknown> | null | undefined;
		const owned = metadata?.["agents.project"] === project;
		const resource = metadata?.["agents.resource"];
		const logicalName = owned && typeof resource === "string" && resource.trim() ? resource.trim() : undefined;
		index.set(id, {
			logical_name: logicalName,
			archived: raw.archived_at != null,
			owned,
		});
	}
	return index;
}

/**
 * Resolve roster member ids to project logical names or explicit external Agent
 * references. Missing remote resources and inconsistent project-owned metadata
 * still fail closed before sync writes a file.
 */
export function memberDeclResolver(index: ReverseIndex): (memberId: string) => MultiagentMemberDecl {
	const claims = new Map<string, number>();
	for (const entry of index.values()) {
		if (!entry.logical_name) continue;
		claims.set(entry.logical_name, (claims.get(entry.logical_name) ?? 0) + 1);
	}
	return (memberId: string): MultiagentMemberDecl => {
		const entry = index.get(memberId);
		if (!entry) {
			throw new UserError(
				`sync.multiagent.member.unresolved: roster member '${memberId}' is missing from the /agents listing.`,
			);
		}
		if (!entry.owned) return { agent_id: memberId };
		if (entry.archived) {
			throw new UserError(
				`sync.multiagent.member.archived: roster member '${memberId}' is archived; restore it before syncing.`,
			);
		}
		const name = entry.logical_name;
		if (!name) {
			throw new UserError(
				`sync.multiagent.member.unresolved: roster member '${memberId}' carries no agents.resource metadata.`,
			);
		}
		if ((claims.get(name) ?? 0) > 1) {
			throw new UserError(
				`sync.multiagent.member.ambiguous: logical name '${name}' is claimed by multiple remote agents.`,
			);
		}
		return name;
	};
}

/**
 * Reverse-map a remote `multiagent` field into the agents.yaml decl shape — project
 * logical names or explicit external Agent ids. Unrepresentable member shapes fail
 * closed rather than being silently dropped.
 */
export function reverseMultiagentDecl(
	raw: unknown,
	resolveMember?: (memberId: string) => MultiagentMemberDecl,
): { type: "coordinator"; agents: MultiagentMemberDecl[] } | undefined {
	if (raw === null || raw === undefined) return undefined;
	if (typeof raw !== "object") return undefined;
	const roster = raw as { type?: unknown; agents?: unknown };
	if (roster.type !== undefined && roster.type !== "coordinator") {
		throw new UserError(
			`sync.multiagent.member.unresolved: remote multi-agent type '${String(roster.type)}' cannot be represented (coordinator only).`,
		);
	}
	if (!Array.isArray(roster.agents) || roster.agents.length === 0) return undefined;
	if (!resolveMember) {
		throw new UserError(
			"sync.multiagent.member.unresolved: reverse-mapping a multi-agent roster requires a member name resolver.",
		);
	}
	return {
		type: "coordinator",
		agents: roster.agents.map((member) => resolveMember(rosterMemberId(member))),
	};
}

function rosterMemberId(member: unknown): string {
	if (typeof member === "string") return member;
	if (typeof member === "object" && member !== null) {
		const m = member as { type?: unknown; id?: unknown };
		if (m.type === "agent" && typeof m.id === "string") return m.id;
	}
	throw new UserError("sync.multiagent.member.unresolved: roster member is not a representable agent reference.");
}
