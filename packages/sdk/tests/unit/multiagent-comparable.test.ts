import { describe, expect, test } from "bun:test";
import { canonicalizeDesiredRoster, canonicalizeRemoteRoster } from "../../src/internal/multiagent/comparable.ts";
import type { ResolvedMultiagentRoster } from "../../src/internal/multiagent/model.ts";
import { BailianAdapter } from "../../src/internal/providers/bailian/adapter.ts";
import type { ResolvedAgentRefs, ResolvedTemplateRefs } from "../../src/internal/providers/interface.ts";
import { QoderAdapter } from "../../src/internal/providers/qoder/adapter.ts";

function roster(members: ResolvedMultiagentRoster["members"]): ResolvedMultiagentRoster {
	return { type: "coordinator", members };
}

describe("canonicalizeDesiredRoster", () => {
	test("emits sorted unique member ids", () => {
		const canonical = canonicalizeDesiredRoster(
			roster([
				{ logical_name: "writer", resource_type: "agent", remote_id: "agent_writer_1" },
				{ logical_name: "reviewer", resource_type: "agent", remote_id: "agent_reviewer_1" },
				{ logical_name: "duplicate", resource_type: "agent", remote_id: "agent_reviewer_1" },
			]),
		);
		expect(canonical).toEqual({ type: "coordinator", member_ids: ["agent_reviewer_1", "agent_writer_1"] });
	});

	test("returns undefined for a missing roster", () => {
		expect(canonicalizeDesiredRoster(undefined)).toBeUndefined();
	});
});

describe("canonicalizeRemoteRoster", () => {
	test("managed reads id and ignores remote member versions", () => {
		const result = canonicalizeRemoteRoster(
			{
				type: "coordinator",
				agents: [
					{ type: "agent", id: "agent_writer_1", version: 7 },
					{ type: "agent", id: "agent_reviewer_1", version: 5 },
					{ type: "agent", id: "agent_reviewer_1", version: 6 },
				],
			},
			"managed",
		);
		expect(result).toEqual({
			supported: true,
			roster: { type: "coordinator", member_ids: ["agent_reviewer_1", "agent_writer_1"] },
		});
	});

	test("forward reads template_id and ignores remote member name and version", () => {
		const result = canonicalizeRemoteRoster(
			{
				type: "coordinator",
				agents: [
					{ type: "agent", template_id: "tmpl_writer_1", name: "Writer Display", version: 2 },
					{ type: "agent", template_id: "tmpl_reviewer_1", name: "Reviewer Display", version: 9 },
				],
			},
			"forward",
		);
		expect(result).toEqual({
			supported: true,
			roster: { type: "coordinator", member_ids: ["tmpl_reviewer_1", "tmpl_writer_1"] },
		});
	});

	test("treats null, missing and empty rosters as no roster", () => {
		for (const raw of [null, undefined, { type: "coordinator", agents: [] }]) {
			expect(canonicalizeRemoteRoster(raw, "managed")).toEqual({ supported: true });
			expect(canonicalizeRemoteRoster(raw, "forward")).toEqual({ supported: true });
		}
	});

	test("rejects self, advisor and unknown member types as unsupported", () => {
		for (const member of [{ type: "self" }, { type: "advisor", id: "adv_1" }, { type: "relayer", id: "r_1" }]) {
			const result = canonicalizeRemoteRoster({ type: "coordinator", agents: [member] }, "managed");
			expect(result.supported).toBe(false);
		}
	});
});

describe("Qoder comparable round-trips", () => {
	const adapter = new QoderAdapter("pt-test", undefined, "tmp") as any;

	test("managed agent desired equals remote despite platform-assigned member versions", () => {
		const decl = {
			model: "auto",
			instructions: "You are the lead.",
			multiagent: { type: "coordinator" as const, agents: ["reviewer", "writer"] },
		};
		const refs: ResolvedAgentRefs = {
			skill_ids: [],
			multiagent: roster([
				{ logical_name: "reviewer", resource_type: "agent", remote_id: "agent_reviewer_1" },
				{ logical_name: "writer", resource_type: "agent", remote_id: "agent_writer_1" },
			]),
		};
		const remoteRaw = {
			name: "lead",
			model: "auto",
			system: "You are the lead.",
			tools: [{ type: "agent_toolset_20260401" }],
			multiagent: {
				type: "coordinator",
				agents: [
					{ type: "agent", id: "agent_reviewer_1", version: 5 },
					{ type: "agent", id: "agent_writer_1", version: 7 },
				],
			},
			metadata: { "agents.project": "tmp", "agents.resource": "lead" },
		};

		const desired = adapter.normalizeDesiredResource("agent", "lead", decl, refs);
		const remote = adapter.normalizeRemote("agent", remoteRaw);

		expect(remote).toEqual(desired);
		expect(remote).toMatchObject({
			multiagent: { type: "coordinator", member_ids: ["agent_reviewer_1", "agent_writer_1"] },
		});
	});

	test("forward template desired equals remote despite remote member name and version", () => {
		const decl = {
			model: "auto",
			instructions: "You are the lead.",
			environment: "dev",
			multiagent: { type: "coordinator" as const, agents: ["reviewer"] },
		};
		const refs: ResolvedTemplateRefs = {
			skill_ids: [],
			environment_id: "env_dev",
			vault_ids: [],
			multiagent: roster([{ logical_name: "reviewer", resource_type: "template", remote_id: "tmpl_reviewer_1" }]),
		};
		const remoteRaw = {
			name: "lead",
			description: "",
			model: "auto",
			system: "You are the lead.",
			environment_id: "env_dev",
			vault_ids: [],
			files: {},
			skills: [],
			multiagent: {
				type: "coordinator",
				agents: [{ type: "agent", template_id: "tmpl_reviewer_1", name: "Reviewer Display", version: 3 }],
			},
			metadata: { "agents.project": "tmp", "agents.resource": "lead" },
		};

		const desired = adapter.normalizeDesiredResource("template", "lead", decl, refs);
		const remote = adapter.normalizeRemote("template", remoteRaw);

		expect(remote).toEqual(desired);
		expect(remote).toMatchObject({
			multiagent: { type: "coordinator", member_ids: ["tmpl_reviewer_1"] },
		});
	});

	test("clearing the roster canonicalizes to no roster on both sides", () => {
		const decl = { model: "auto", instructions: "You are the lead." };
		const desired = adapter.normalizeDesiredResource("agent", "lead", decl, { skill_ids: [] });
		const remote = adapter.normalizeRemote("agent", {
			name: "lead",
			model: "auto",
			system: "You are the lead.",
			tools: [{ type: "agent_toolset_20260401" }],
			multiagent: null,
			metadata: { "agents.project": "tmp", "agents.resource": "lead" },
		});
		expect(remote).toEqual(desired);
	});
});

describe("Bailian comparable round-trips", () => {
	const adapter = new BailianAdapter("sk-test", "ws-test", "https://bailian.test/api/v1/agentstudio") as any;

	test("null and numeric member versions both stay drift-free", () => {
		const decl = {
			model: "qwen3.7-max",
			instructions: "You are the lead.",
			multiagent: { type: "coordinator" as const, agents: ["reviewer", "writer"] },
		};
		const refs: ResolvedAgentRefs = {
			skill_ids: [],
			multiagent: roster([
				{ logical_name: "reviewer", resource_type: "agent", remote_id: "agent_reviewer_1" },
				{ logical_name: "writer", resource_type: "agent", remote_id: "agent_writer_1" },
			]),
		};
		const desired = adapter.normalizeDesiredResource("agent", "lead", decl, refs);

		for (const version of [null, 2]) {
			const remote = adapter.normalizeRemote("agent", {
				name: "lead",
				model: "qwen3.7-max",
				system: "You are the lead.",
				tools: [],
				multiagent: {
					type: "coordinator",
					agents: [
						{ type: "agent", id: "agent_reviewer_1", version },
						{ type: "agent", id: "agent_writer_1", version },
					],
				},
				metadata: {},
			});
			expect(remote).toEqual(desired);
			expect(remote).toMatchObject({
				multiagent: { type: "coordinator", member_ids: ["agent_reviewer_1", "agent_writer_1"] },
			});
		}
	});

	test("clearing the roster canonicalizes to no roster on both sides", () => {
		const decl = { model: "qwen3.7-max", instructions: "You are the lead." };
		const desired = adapter.normalizeDesiredResource("agent", "lead", decl, { skill_ids: [] });
		const remote = adapter.normalizeRemote("agent", {
			name: "lead",
			model: "qwen3.7-max",
			system: "You are the lead.",
			tools: [],
			multiagent: { type: "coordinator", agents: [] },
			metadata: {},
		});
		expect(remote).toEqual(desired);
	});
});
