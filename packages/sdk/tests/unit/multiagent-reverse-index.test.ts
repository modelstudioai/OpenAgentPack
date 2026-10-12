import { describe, expect, test } from "bun:test";
import { buildReverseIndex, memberDeclResolver } from "../../src/internal/multiagent/reverse-index.ts";
import { agentToDecl } from "../../src/internal/providers/qoder/mapper.ts";

function remoteAgent(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id,
		type: "agent",
		name: `display-${id}`,
		model: "auto",
		system: "Help.",
		archived_at: null,
		metadata: { "agents.project": "tmp", "agents.resource": id },
		...overrides,
	};
}

function coordinatorRaw(memberIds: string[]): Record<string, unknown> {
	return remoteAgent("lead", {
		multiagent: {
			type: "coordinator",
			agents: memberIds.map((id) => ({ type: "agent", id })),
		},
	});
}

describe("reverse index construction", () => {
	test("derives logical names only from managed metadata with a matching project", () => {
		const index = buildReverseIndex(
			[
				remoteAgent("agent_reviewer_1", { metadata: { "agents.project": "tmp", "agents.resource": "reviewer" } }),
				remoteAgent("agent_foreign_1", { metadata: { "agents.project": "other", "agents.resource": "spy" } }),
				remoteAgent("agent_unmanaged_1", { metadata: {} }),
				remoteAgent("agent_archived_1", {
					metadata: { "agents.project": "tmp", "agents.resource": "ghost" },
					archived_at: "2026-07-19T00:00:00Z",
				}),
			],
			"tmp",
		);

		expect(index.get("agent_reviewer_1")).toMatchObject({ logical_name: "reviewer", archived: false, owned: true });
		expect(index.get("agent_foreign_1")).toMatchObject({ owned: false });
		expect(index.get("agent_unmanaged_1")).toMatchObject({ owned: false });
		expect(index.get("agent_archived_1")).toMatchObject({ logical_name: "ghost", archived: true, owned: true });
	});

	test("never falls back to display names or ids for logical names", () => {
		const index = buildReverseIndex([remoteAgent("agent_1", { metadata: {} })], "tmp");
		const entry = index.get("agent_1")!;
		expect(entry.logical_name).toBeUndefined();
	});
});

describe("reverse mapping strategies", () => {
	test("maps a full roster to logical names", () => {
		const agents = [
			coordinatorRaw(["agent_reviewer_1", "agent_writer_1"]),
			remoteAgent("agent_reviewer_1", { metadata: { "agents.project": "tmp", "agents.resource": "reviewer" } }),
			remoteAgent("agent_writer_1", { metadata: { "agents.project": "tmp", "agents.resource": "writer" } }),
		];
		const decl = agentToDecl(agents[0]!, memberDeclResolver(buildReverseIndex(agents, "tmp")));
		expect(decl.multiagent).toEqual({ type: "coordinator", agents: ["reviewer", "writer"] });
	});

	test("fails closed when a member is missing from the full agent list", () => {
		const agents = [coordinatorRaw(["agent_gone_1"])];
		expect(() => agentToDecl(agents[0]!, memberDeclResolver(buildReverseIndex(agents, "tmp")))).toThrow(
			/sync\.multiagent\.member\.unresolved/,
		);
	});

	test("fails closed when a member is archived", () => {
		const agents = [
			coordinatorRaw(["agent_archived_1"]),
			remoteAgent("agent_archived_1", {
				metadata: { "agents.project": "tmp", "agents.resource": "ghost" },
				archived_at: "2026-07-19T00:00:00Z",
			}),
		];
		expect(() => agentToDecl(agents[0]!, memberDeclResolver(buildReverseIndex(agents, "tmp")))).toThrow(
			/sync\.multiagent\.member\.archived/,
		);
	});

	test("preserves a member owned by another project as an external Agent reference", () => {
		const agents = [
			coordinatorRaw(["agent_foreign_1"]),
			remoteAgent("agent_foreign_1", { metadata: { "agents.project": "other", "agents.resource": "spy" } }),
		];
		const decl = agentToDecl(agents[0]!, memberDeclResolver(buildReverseIndex(agents, "tmp")));
		expect(decl.multiagent).toEqual({ type: "coordinator", agents: [{ agent_id: "agent_foreign_1" }] });
	});

	test("preserves an unmanaged member as an external Agent reference", () => {
		const agents = [coordinatorRaw(["agent_external_1"]), remoteAgent("agent_external_1", { metadata: {} })];
		const decl = agentToDecl(agents[0]!, memberDeclResolver(buildReverseIndex(agents, "tmp")));
		expect(decl.multiagent).toEqual({ type: "coordinator", agents: [{ agent_id: "agent_external_1" }] });
	});

	test("fails closed when multiple remote resources claim the same logical name", () => {
		const agents = [
			coordinatorRaw(["agent_reviewer_1"]),
			remoteAgent("agent_reviewer_1", { metadata: { "agents.project": "tmp", "agents.resource": "reviewer" } }),
			remoteAgent("agent_reviewer_2", {
				name: "display-agent_reviewer_2",
				metadata: { "agents.project": "tmp", "agents.resource": "reviewer" },
			}),
		];
		expect(() => agentToDecl(agents[0]!, memberDeclResolver(buildReverseIndex(agents, "tmp")))).toThrow(
			/sync\.multiagent\.member\.ambiguous/,
		);
	});

	test("leaves agents without a roster untouched by the resolver", () => {
		const agents = [
			remoteAgent("agent_reviewer_1", { metadata: { "agents.project": "tmp", "agents.resource": "reviewer" } }),
		];
		const decl = agentToDecl(agents[0]!, memberDeclResolver(buildReverseIndex(agents, "tmp")));
		expect(decl.multiagent).toBeUndefined();
	});
});
