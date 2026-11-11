import { UserError } from "../errors.ts";
import type { MultiagentMemberDecl } from "../types/config.ts";

type SelfMember = Extract<MultiagentMemberDecl, { type: "self" }>;

export type ResolvedMultiagentMember =
	| SelfMember
	| {
			/** Present only when the member is owned and named by this project. */
			logical_name?: string;
			resource_type: "agent" | "template";
			remote_id: string;
	  };

export interface ResolvedMultiagentRoster {
	type: "coordinator";
	members: ResolvedMultiagentMember[];
}

/** Provider null identity placeholders are unset; non-null identities and extensions are not Self. */
export function isSelfRosterMember(value: unknown): value is SelfMember {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value) &&
		"type" in value &&
		value.type === "self" &&
		Object.keys(value).every(
			(key) =>
				key === "type" || ((key === "id" || key === "version") && (value as Record<string, unknown>)[key] === null),
		)
	);
}

/** Native Self must never be serialized as an external member id. */
export function externalMultiagentMemberId(member: ResolvedMultiagentMember): string {
	if ("type" in member) throw new UserError("multiagent.self.unsupported: Self requires Bailian managed delivery.");
	return member.remote_id;
}
