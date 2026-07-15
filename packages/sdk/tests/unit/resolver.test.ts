import { expect, test } from "bun:test";
import { requireRef, resolveAgentRefs, resolveRef } from "../../src/internal/executor/resolver.ts";
import { StateManager } from "../../src/internal/state/state-manager.ts";
import type { ProjectConfig } from "../../src/internal/types/config.ts";

function makeState(): StateManager {
	const state = StateManager.initialize("/tmp/test-state.json");
	state.setResource({
		address: { type: "environment", name: "dev", provider: "qoder" },
		remote_id: "env_abc123",
		content_hash: "hash1",
	});
	state.setResource({
		address: { type: "agent", name: "researcher", provider: "qoder" },
		remote_id: "agent_xyz",
		version: 2,
		content_hash: "hash2",
	});
	state.setResource({
		address: { type: "skill", name: "code-review", provider: "qoder" },
		remote_id: "skill_local",
		content_hash: "hash3",
	});
	return state;
}

test("resolveRef returns remote_id when resource exists", () => {
	const state = makeState();
	const id = resolveRef(state, { type: "environment", name: "dev", provider: "qoder" });
	expect(id).toBe("env_abc123");
});

test("resolveRef returns undefined when resource does not exist", () => {
	const state = makeState();
	const id = resolveRef(state, { type: "environment", name: "staging", provider: "qoder" });
	expect(id).toBeUndefined();
});

test("requireRef returns remote_id when resource exists", () => {
	const state = makeState();
	const id = requireRef(state, { type: "agent", name: "researcher", provider: "qoder" });
	expect(id).toBe("agent_xyz");
});

test("requireRef throws when resource is missing", () => {
	const state = makeState();
	expect(() => requireRef(state, { type: "agent", name: "nonexistent", provider: "qoder" })).toThrow(
		/not found in state/,
	);
});

test("resolveAgentRefs supports managed and external skill references", () => {
	const state = makeState();
	const config: ProjectConfig = {
		version: "1",
		providers: { qoder: {} },
		agents: {
			assistant: {
				model: "qwen3",
				instructions: "test",
				skills: [
					"code-review",
					{ type: "official", skill_id: "pptx", version: "1.0" },
					{ type: "custom", skill_id: "skill_uploaded", version: "2.0" },
				],
			},
		},
	};

	const refs = resolveAgentRefs("assistant", config, "qoder", state);
	expect(refs.skill_ids).toEqual([
		{ type: "custom", skill_id: "skill_local" },
		{ type: "official", skill_id: "pptx", version: "1.0" },
		{ type: "custom", skill_id: "skill_uploaded", version: "2.0" },
	]);
});

test("resolveAgentRefs throws when a managed skill is not in state", () => {
	const state = makeState();
	const config: ProjectConfig = {
		version: "1",
		providers: { qoder: {} },
		agents: {
			assistant: {
				model: "qwen3",
				instructions: "test",
				skills: ["missing-skill"],
			},
		},
	};

	expect(() => resolveAgentRefs("assistant", config, "qoder", state)).toThrow(/not found in state/);
});
