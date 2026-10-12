export interface ResolvedMultiagentMember {
	/** Present only when the member is owned and named by this project. */
	logical_name?: string;
	resource_type: "agent" | "template";
	remote_id: string;
}

export interface ResolvedMultiagentRoster {
	type: "coordinator";
	members: ResolvedMultiagentMember[];
}
