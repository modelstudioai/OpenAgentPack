import { describe, expect, test } from "bun:test";
import { toSessionInfo as bailianToSessionInfo } from "../../src/internal/providers/bailian/adapter.ts";
import { toSessionInfo as claudeToSessionInfo } from "../../src/internal/providers/claude/adapter.ts";
import { mapSession as mapClaudeSession } from "../../src/internal/providers/claude/mapper.ts";
import { toSessionInfo as qoderToSessionInfo } from "../../src/internal/providers/qoder/adapter.ts";
import { mapSession as mapQoderSession } from "../../src/internal/providers/qoder/mapper.ts";
import type { SessionBindings } from "../../src/internal/types/session.ts";

function fullBindings(): SessionBindings {
	return {
		agent_id: "agent_123",
		agent_version: 2,
		environment_id: "env_456",
		vault_ids: ["vault_a", "vault_b"],
		memory_store_ids: ["ms_1", "ms_2"],
		title: "Research session",
		metadata: { team: "eng" },
	};
}

function minimalBindings(): SessionBindings {
	return {
		agent_id: "agent_min",
		environment_id: "env_min",
		vault_ids: [],
		memory_store_ids: [],
	};
}

describe("Qoder mapSession", () => {
	test("full bindings produce correct body with resources array", () => {
		const body = mapQoderSession(fullBindings()) as Record<string, unknown>;

		expect(body.agent).toBe("agent_123");
		expect(body.environment_id).toBe("env_456");
		expect(body.vault_ids).toEqual(["vault_a", "vault_b"]);
		expect(body.resources).toEqual([
			{ type: "memory_store", memory_store_id: "ms_1" },
			{ type: "memory_store", memory_store_id: "ms_2" },
		]);
		expect(body.memory_store_ids).toBeUndefined();
		expect(body.title).toBe("Research session");
		expect(body.metadata).toEqual({ team: "eng" });
	});

	test("minimal bindings omit optional fields", () => {
		const body = mapQoderSession(minimalBindings()) as Record<string, unknown>;

		expect(body.agent).toBe("agent_min");
		expect(body.environment_id).toBe("env_min");
		expect(body.vault_ids).toBeUndefined();
		expect(body.resources).toBeUndefined();
		expect(body.memory_store_ids).toBeUndefined();
		expect(body.title).toBeUndefined();
		expect(body.metadata).toBeUndefined();
	});

	test("memory_stores go to resources array, not memory_store_ids", () => {
		const bindings = minimalBindings();
		bindings.memory_store_ids = ["ms_x"];
		const body = mapQoderSession(bindings) as Record<string, unknown>;

		expect(body.resources).toEqual([{ type: "memory_store", memory_store_id: "ms_x" }]);
		expect(body.memory_store_ids).toBeUndefined();
	});
});

describe("Claude mapSession", () => {
	test("full bindings produce correct body with resources array", () => {
		const body = mapClaudeSession(fullBindings()) as Record<string, unknown>;

		expect(body.agent).toEqual({
			id: "agent_123",
			type: "agent",
			version: 2,
		});
		expect(body.environment_id).toBe("env_456");
		expect(body.vault_ids).toEqual(["vault_a", "vault_b"]);
		expect(body.resources).toEqual([
			{ type: "memory_store", memory_store_id: "ms_1" },
			{ type: "memory_store", memory_store_id: "ms_2" },
		]);
		expect(body.memory_store_ids).toBeUndefined();
		expect(body.title).toBe("Research session");
		expect(body.metadata).toEqual({ team: "eng" });
	});

	test("minimal bindings use agent_id string directly (no version)", () => {
		const body = mapClaudeSession(minimalBindings()) as Record<string, unknown>;

		expect(body.agent).toBe("agent_min");
		expect(body.environment_id).toBe("env_min");
		expect(body.vault_ids).toBeUndefined();
		expect(body.resources).toBeUndefined();
		expect(body.title).toBeUndefined();
	});

	test("memory_stores go to resources array, not memory_store_ids", () => {
		const bindings = minimalBindings();
		bindings.memory_store_ids = ["ms_x"];
		const body = mapClaudeSession(bindings) as Record<string, unknown>;

		expect(body.resources).toEqual([{ type: "memory_store", memory_store_id: "ms_x" }]);
		expect(body.memory_store_ids).toBeUndefined();
	});
});

// --- toSessionInfo (response parsing) ---

describe("Claude toSessionInfo", () => {
	test("full response with nested agent and resources", () => {
		const info = claudeToSessionInfo({
			id: "sess_abc",
			agent: { id: "agent_123", type: "agent", version: 2 },
			environment_id: "env_456",
			status: "idle",
			title: "Test session",
			vault_ids: ["vault_a"],
			resources: [
				{ type: "memory_store", memory_store_id: "ms_1" },
				{ type: "memory_store", memory_store_id: "ms_2" },
				{ type: "file", file_id: "file_x" },
			],
			created_at: "2026-01-01T00:00:00Z",
			updated_at: "2026-01-01T01:00:00Z",
		});

		expect(info.id).toBe("sess_abc");
		expect(info.agent_id).toBe("agent_123");
		expect(info.environment_id).toBe("env_456");
		expect(info.status).toBe("idle");
		expect(info.title).toBe("Test session");
		expect(info.vault_ids).toEqual(["vault_a"]);
		expect(info.memory_store_ids).toEqual(["ms_1", "ms_2"]);
		expect(info.created_at).toBe("2026-01-01T00:00:00Z");
		expect(info.updated_at).toBe("2026-01-01T01:00:00Z");
	});

	test("minimal response — no vault_ids, no resources, no title", () => {
		const info = claudeToSessionInfo({
			id: "sess_min",
			agent: { id: "agent_min" },
			environment_id: "env_min",
			status: "processing",
			created_at: "2026-01-01T00:00:00Z",
			updated_at: "2026-01-01T00:00:00Z",
		});

		expect(info.id).toBe("sess_min");
		expect(info.agent_id).toBe("agent_min");
		expect(info.title).toBeUndefined();
		expect(info.vault_ids).toEqual([]);
		expect(info.memory_store_ids).toEqual([]);
	});

	test("resources filters only memory_store type", () => {
		const info = claudeToSessionInfo({
			id: "sess_1",
			agent: { id: "a" },
			environment_id: "e",
			status: "idle",
			resources: [
				{ type: "file", file_id: "f1" },
				{ type: "github_repository", url: "https://github.com/test" },
			],
			created_at: "2026-01-01T00:00:00Z",
			updated_at: "2026-01-01T00:00:00Z",
		});

		expect(info.memory_store_ids).toEqual([]);
	});

	test("missing agent object falls back to empty string", () => {
		const info = claudeToSessionInfo({
			id: "sess_no_agent",
			environment_id: "e",
			status: "idle",
			created_at: "2026-01-01T00:00:00Z",
			updated_at: "2026-01-01T00:00:00Z",
		});

		expect(info.agent_id).toBe("");
	});

	test("vault_ids derived from resources when top-level is empty (resources create form)", () => {
		const info = claudeToSessionInfo({
			id: "sess_claude_res",
			agent: { id: "a" },
			environment_id: "e",
			status: "idle",
			vault_ids: [],
			resources: [
				{ type: "file", file_id: "f1" },
				{ type: "vault", id: "vlt_res" },
			],
			created_at: "2026-01-01T00:00:00Z",
			updated_at: "2026-01-01T00:00:00Z",
		});

		expect(info.vault_ids).toEqual(["vlt_res"]);
	});
});

describe("Qoder toSessionInfo", () => {
	test("full response with flat fields", () => {
		const info = qoderToSessionInfo({
			id: "sess_q1",
			agent_id: "agent_q1",
			environment_id: "env_q1",
			status: "idle",
			title: "Qoder session",
			vault_ids: ["v1", "v2"],
			memory_store_ids: ["ms_q1"],
			created_at: "2026-02-01T00:00:00Z",
			updated_at: "2026-02-01T01:00:00Z",
		});

		expect(info.id).toBe("sess_q1");
		expect(info.agent_id).toBe("agent_q1");
		expect(info.environment_id).toBe("env_q1");
		expect(info.status).toBe("idle");
		expect(info.title).toBe("Qoder session");
		expect(info.vault_ids).toEqual(["v1", "v2"]);
		expect(info.memory_store_ids).toEqual(["ms_q1"]);
	});

	test("missing optional fields default to empty arrays", () => {
		const info = qoderToSessionInfo({
			id: "sess_q2",
			agent_id: "agent_q2",
			environment_id: "env_q2",
			status: "processing",
			created_at: "2026-02-01T00:00:00Z",
			updated_at: "2026-02-01T00:00:00Z",
		});

		expect(info.title).toBeUndefined();
		expect(info.vault_ids).toEqual([]);
		expect(info.memory_store_ids).toEqual([]);
	});

	test("vault_ids derived from resources when top-level is empty (resources create form)", () => {
		const info = qoderToSessionInfo({
			id: "sess_q_res",
			agent_id: "agent_q3",
			environment_id: "env_q3",
			status: "idle",
			vault_ids: [],
			resources: [
				{ type: "file", file_id: "f1" },
				{ type: "vault", id: "vlt_res" },
			],
			created_at: "2026-02-01T00:00:00Z",
			updated_at: "2026-02-01T00:00:00Z",
		});

		expect(info.vault_ids).toEqual(["vlt_res"]);
	});
});

describe("Bailian toSessionInfo", () => {
	test("full response with nested agent", () => {
		const info = bailianToSessionInfo({
			id: "sess_b1",
			agent: { id: "agent_b1" },
			environment_id: "env_b1",
			status: "idle",
			title: "Bailian session",
			created_at: "2026-03-01T00:00:00Z",
			updated_at: "2026-03-01T01:00:00Z",
		});

		expect(info.id).toBe("sess_b1");
		expect(info.agent_id).toBe("agent_b1");
		expect(info.environment_id).toBe("env_b1");
		expect(info.status).toBe("idle");
		expect(info.title).toBe("Bailian session");
	});

	test("vault_ids empty when neither top-level nor resources carry a vault", () => {
		const info = bailianToSessionInfo({
			id: "sess_b2",
			agent: { id: "a" },
			environment_id: "e",
			status: "idle",
			created_at: "2026-03-01T00:00:00Z",
			updated_at: "2026-03-01T00:00:00Z",
		});

		expect(info.vault_ids).toEqual([]);
		expect(info.memory_store_ids).toEqual([]);
	});

	test("vault_ids read from top-level vault_ids (top-level create form)", () => {
		const info = bailianToSessionInfo({
			id: "sess_b_top",
			agent: { id: "a" },
			environment_id: "e",
			status: "idle",
			vault_ids: ["vlt_top"],
			resources: [],
			created_at: "2026-03-01T00:00:00Z",
			updated_at: "2026-03-01T00:00:00Z",
		});

		expect(info.vault_ids).toEqual(["vlt_top"]);
	});

	test("vault_ids derived from resources when top-level is empty (resources create form)", () => {
		const info = bailianToSessionInfo({
			id: "sess_b_res",
			agent: { id: "a" },
			environment_id: "e",
			status: "idle",
			vault_ids: [],
			resources: [
				{ type: "file", file_id: "f1" },
				{ type: "vault", id: "vlt_res" },
			],
			created_at: "2026-03-01T00:00:00Z",
			updated_at: "2026-03-01T00:00:00Z",
		});

		expect(info.vault_ids).toEqual(["vlt_res"]);
	});

	test("missing agent object falls back to empty string", () => {
		const info = bailianToSessionInfo({
			id: "sess_b3",
			environment_id: "e",
			status: "idle",
			created_at: "2026-03-01T00:00:00Z",
			updated_at: "2026-03-01T00:00:00Z",
		});

		expect(info.agent_id).toBe("");
	});
});
