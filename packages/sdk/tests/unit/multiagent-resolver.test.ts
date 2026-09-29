import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAgentRefs, resolveTemplateRefs } from "../../src/internal/executor/resolver.ts";
import { StateManager } from "../../src/internal/state/state-manager.ts";
import type { ProjectConfig } from "../../src/internal/types/config.ts";

function tmpPath(): string {
	return join(tmpdir(), `multiagent-resolver-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

function setAgent(state: StateManager, name: string, remoteId: string, type: "agent" | "template" = "agent") {
	state.setResource({
		address: { type, name, provider: "qoder" },
		remote_id: remoteId,
		content_hash: "h",
		desired_hash: "h",
	});
}

const managedConfig: ProjectConfig = {
	version: "1",
	providers: { qoder: {} },
	defaults: { provider: "qoder" },
	agents: {
		lead: {
			model: "auto",
			instructions: "Coordinate.",
			multiagent: { type: "coordinator", agents: ["reviewer", "writer"] },
		},
		reviewer: { model: "auto", instructions: "Review." },
		writer: { model: "auto", instructions: "Write." },
	},
};

const forwardConfig: ProjectConfig = {
	version: "1",
	providers: { qoder: {} },
	defaults: { provider: "qoder" },
	environments: { dev: { environment_id: "env_dev" } },
	agents: {
		lead: {
			model: "auto",
			instructions: "Coordinate.",
			environment: "dev",
			delivery: { qoder: { type: "forward" } },
			multiagent: { type: "coordinator", agents: ["reviewer", "writer"] },
		},
		reviewer: {
			model: "auto",
			instructions: "Review.",
			environment: "dev",
			delivery: { qoder: { type: "forward" } },
		},
		writer: {
			model: "auto",
			instructions: "Write.",
			environment: "dev",
			delivery: { qoder: { type: "forward" } },
		},
	},
};

describe("materialization-aware reference resolution", () => {
	test("resolves Managed coordinator members as agent addresses", () => {
		const state = StateManager.initialize(tmpPath());
		setAgent(state, "reviewer", "agent_reviewer_1");
		setAgent(state, "writer", "agent_writer_1");

		const refs = resolveAgentRefs("lead", managedConfig, "qoder", state);

		expect(refs.multiagent).toEqual({
			type: "coordinator",
			members: [
				{ logical_name: "reviewer", resource_type: "agent", remote_id: "agent_reviewer_1" },
				{ logical_name: "writer", resource_type: "agent", remote_id: "agent_writer_1" },
			],
		});
	});

	test("resolves a mixed Managed roster without requiring external members in state", () => {
		const state = StateManager.initialize(tmpPath());
		setAgent(state, "reviewer", "agent_reviewer_1");
		const config: ProjectConfig = {
			...managedConfig,
			agents: {
				...managedConfig.agents,
				lead: {
					...managedConfig.agents!.lead!,
					multiagent: { type: "coordinator", agents: ["reviewer", { agent_id: "agent_external_1" }] },
				},
			},
		};

		const refs = resolveAgentRefs("lead", config, "qoder", state);

		expect(refs.multiagent).toEqual({
			type: "coordinator",
			members: [
				{ logical_name: "reviewer", resource_type: "agent", remote_id: "agent_reviewer_1" },
				{ resource_type: "agent", remote_id: "agent_external_1" },
			],
		});
	});

	test("resolves Forward coordinator members as template addresses", () => {
		const state = StateManager.initialize(tmpPath());
		setAgent(state, "reviewer", "tmpl_reviewer_1", "template");
		setAgent(state, "writer", "tmpl_writer_1", "template");

		const refs = resolveTemplateRefs("lead", forwardConfig, "qoder", state);

		expect(refs.multiagent).toEqual({
			type: "coordinator",
			members: [
				{ logical_name: "reviewer", resource_type: "template", remote_id: "tmpl_reviewer_1" },
				{ logical_name: "writer", resource_type: "template", remote_id: "tmpl_writer_1" },
			],
		});
	});

	test("throws instead of silently skipping a member missing from state", () => {
		const state = StateManager.initialize(tmpPath());
		setAgent(state, "reviewer", "agent_reviewer_1");

		expect(() => resolveAgentRefs("lead", managedConfig, "qoder", state)).toThrow(
			/qoder\.agent\.writer not found in state\. Run `agents apply` first\./,
		);
	});

	test("throws for a Forward member missing from state", () => {
		const state = StateManager.initialize(tmpPath());
		setAgent(state, "reviewer", "tmpl_reviewer_1", "template");

		expect(() => resolveTemplateRefs("lead", forwardConfig, "qoder", state)).toThrow(
			/qoder\.template\.writer not found in state\. Run `agents apply` first\./,
		);
	});

	test("rejects an external Managed Agent in a Forward roster", () => {
		const state = StateManager.initialize(tmpPath());
		const config: ProjectConfig = {
			...forwardConfig,
			agents: {
				...forwardConfig.agents,
				lead: {
					...forwardConfig.agents!.lead!,
					multiagent: { type: "coordinator", agents: [{ agent_id: "agent_external_1" }] },
				},
			},
		};

		expect(() => resolveTemplateRefs("lead", config, "qoder", state)).toThrow(
			/qoder\.template\.multiagent\.external_member/,
		);
	});

	test("leaves the roster unset for an agent without multiagent", () => {
		const state = StateManager.initialize(tmpPath());
		const refs = resolveAgentRefs("reviewer", managedConfig, "qoder", state);
		expect(refs.multiagent).toBeUndefined();
	});

	test("keeps Forward template refs free of agent-address multiagent members", () => {
		const state = StateManager.initialize(tmpPath());
		setAgent(state, "reviewer", "tmpl_reviewer_1", "template");
		setAgent(state, "writer", "tmpl_writer_1", "template");

		const refs = resolveTemplateRefs("lead", forwardConfig, "qoder", state);

		expect(refs.multiagent?.members.every((member) => member.resource_type === "template")).toBe(true);
		expect(refs.environment_id).toBe("env_dev");
	});
});
