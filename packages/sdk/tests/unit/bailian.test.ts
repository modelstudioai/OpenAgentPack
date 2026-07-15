import { afterEach, describe, expect, test } from "bun:test";
import { BailianAdapter } from "../../src/internal/providers/bailian/adapter.ts";
import { bailianConfigSchema } from "../../src/internal/providers/bailian/config.ts";
import { mapAgent, mapEnvironment, mapInitialEvents, mapSession } from "../../src/internal/providers/bailian/mapper.ts";
import type { ResolvedAgentRefs } from "../../src/internal/providers/interface.ts";
import type { AgentDecl, EnvironmentDecl } from "../../src/internal/types/config.ts";
import type { SessionBindings } from "../../src/internal/types/session.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

// --- Config schema (task 5.3) ---

describe("bailianConfigSchema", () => {
	test("accepts valid config with all fields", () => {
		const result = bailianConfigSchema.parse({
			api_key: "sk-abc",
			workspace_id: "ws-123",
			base_url: "https://custom.example.com/api/v1/agentstudio",
		});
		expect(result.api_key).toBe("sk-abc");
		expect(result.workspace_id).toBe("ws-123");
		expect(result.base_url).toBe("https://custom.example.com/api/v1/agentstudio");
	});

	test("accepts config without optional base_url", () => {
		const result = bailianConfigSchema.parse({
			api_key: "sk-abc",
			workspace_id: "ws-123",
		});
		expect(result.base_url).toBeUndefined();
	});

	test("rejects config missing api_key", () => {
		expect(() => bailianConfigSchema.parse({ workspace_id: "ws-123" })).toThrow();
	});

	test("rejects config missing workspace_id", () => {
		expect(() => bailianConfigSchema.parse({ api_key: "sk-abc" })).toThrow();
	});
});

describe("BailianAdapter archived agents", () => {
	test("does not treat an archived agent id as an updatable resource", async () => {
		const adapter = new BailianAdapter("sk-test", "ws-test", "https://bailian.test/api/v1/agentstudio");
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = new URL(String(input));
			if (url.pathname.endsWith("/agents/agent_archived")) {
				return Response.json({
					id: "agent_archived",
					name: "Agents/设计师助手",
					archived_at: "2026-06-28T00:00:00.000Z",
				});
			}
			throw new Error(`unexpected ${url.pathname}${url.search}`);
		}) as typeof fetch;

		await expect(adapter.findResource("agent", "Agents/设计师助手", "agent_archived")).resolves.toBeNull();
	});

	test("refresh treats an archived agent as missing so apply creates a replacement", async () => {
		const adapter = new BailianAdapter("sk-test", "ws-test", "https://bailian.test/api/v1/agentstudio");
		const calls: string[] = [];
		globalThis.fetch = (async (input: RequestInfo | URL) => {
			const url = new URL(String(input));
			calls.push(`${url.pathname}${url.search}`);
			if (url.pathname.endsWith("/agents/agent_archived")) {
				return Response.json({
					id: "agent_archived",
					name: "Agents/设计师助手",
					archived_at: "2026-06-28T00:00:00.000Z",
				});
			}
			if (url.pathname.endsWith("/agents")) {
				return Response.json({ data: [], next_page: null });
			}
			throw new Error(`unexpected ${url.pathname}${url.search}`);
		}) as typeof fetch;

		const remote = await adapter.readComparableResource("agent", "agent_archived", "Agents/设计师助手");

		expect(remote).toBeNull();
		expect(calls).toContain("/api/v1/agentstudio/agents/agent_archived");
		// The id path now rethrows non-404 / returns null on the accept predicate
		// without a redundant list-scan fallback (locateRemote convergence).
		expect(calls).not.toContain("/api/v1/agentstudio/agents?limit=100");
	});
});

// --- mapAgent (task 5.1) ---

describe("Bailian mapAgent", () => {
	const minimalDecl: AgentDecl = {
		model: "qwen3.7-max",
		instructions: "You are a helpful assistant.",
	};

	const emptyRefs: ResolvedAgentRefs = { skill_ids: [] };

	test("maps instructions to system field", () => {
		const body = mapAgent("helper", minimalDecl, emptyRefs) as Record<string, unknown>;
		expect(body.system).toBe("You are a helpful assistant.");
		expect(body.instructions).toBeUndefined();
	});

	test("wraps model string as { id } object", () => {
		const body = mapAgent("helper", minimalDecl, emptyRefs) as Record<string, unknown>;
		expect(body.model).toEqual({ id: "qwen3.7-max" });
	});

	test("extracts bailian key from per-provider model record", () => {
		const decl: AgentDecl = {
			...minimalDecl,
			model: { claude: "claude-sonnet-4-20250514", bailian: "qwen3-plus" },
		};
		const body = mapAgent("helper", decl, emptyRefs) as Record<string, unknown>;
		expect(body.model).toEqual({ id: "qwen3-plus" });
	});

	test("extracts id from ModelWithSpeed bailian model", () => {
		const decl: AgentDecl = {
			...minimalDecl,
			model: { bailian: { id: "qwen3.7-max", speed: "fast" } },
		};
		const body = mapAgent("helper", decl, emptyRefs) as Record<string, unknown>;
		expect(body.model).toEqual({ id: "qwen3.7-max" });
	});

	test("throws when per-provider record has no bailian key", () => {
		const decl: AgentDecl = {
			...minimalDecl,
			model: { claude: "claude-sonnet-4-20250514" },
		};
		expect(() => mapAgent("helper", decl, emptyRefs)).toThrow("No Bailian model");
	});

	test("maps builtin tools to builtin_toolkit structure", () => {
		const decl: AgentDecl = {
			...minimalDecl,
			tools: { builtin: ["bash", "read", "write"] },
		};
		const body = mapAgent("helper", decl, emptyRefs) as Record<string, unknown>;
		const tools = body.tools as Array<Record<string, unknown>>;

		expect(tools[0]!.type).toBe("builtin_toolkit");
		expect(tools[0]!.default_config).toEqual({ enabled: false });
		expect(tools[0]!.configs).toEqual([
			{ name: "bash", enabled: true },
			{ name: "read", enabled: true },
			{ name: "write", enabled: true },
		]);
	});

	test("maps MCP servers to official type + mcp_toolkit blocks", () => {
		const decl: AgentDecl = {
			...minimalDecl,
			tools: {
				builtin: ["read"],
				mcp: [
					{
						type: "mcp_toolkit",
						mcp_server_name: "WebSearch",
						default_config: { enabled: false },
						configs: [{ name: "bailian_web_search", enabled: true }],
					},
				],
			},
			mcp_servers: [{ type: "official", name: "WebSearch" }],
		};
		const body = mapAgent("helper", decl, emptyRefs) as Record<string, unknown>;

		expect(body.mcp_servers).toEqual([{ type: "official", name: "WebSearch" }]);

		const tools = body.tools as Array<Record<string, unknown>>;
		const mcpTool = tools.find((t) => t.type === "mcp_toolkit");
		expect(mcpTool).toBeDefined();
		expect(mcpTool!.mcp_server_name).toBe("WebSearch");
		expect(mcpTool!.default_config).toEqual({ enabled: false });
		expect(mcpTool!.configs).toEqual([{ name: "bailian_web_search", enabled: true }]);
	});

	test("requires explicit MCP toolkit config for Bailian MCP servers", () => {
		const decl: AgentDecl = {
			...minimalDecl,
			mcp_servers: [{ type: "official", name: "WebSearch" }],
		};

		expect(() => mapAgent("helper", decl, emptyRefs)).toThrow("requires a matching tools.mcp entry");
	});

	test("includes skill refs", () => {
		const refs: ResolvedAgentRefs = {
			skill_ids: [{ type: "custom", skill_id: "skill_abc" }],
		};
		const body = mapAgent("helper", minimalDecl, refs) as Record<string, unknown>;
		expect(body.skills).toEqual([{ type: "customer", skill_id: "skill_abc", version: "1.0" }]);
	});

	test("injects agents metadata when projectName provided", () => {
		const body = mapAgent("helper", minimalDecl, emptyRefs, undefined, "my-project") as Record<string, unknown>;
		const meta = body.metadata as Record<string, string>;
		expect(meta["agents.project"]).toBe("my-project");
		expect(meta["agents.resource"]).toBe("helper");
	});

	test("passes version for update", () => {
		const body = mapAgent("helper", minimalDecl, emptyRefs, 3) as Record<string, unknown>;
		expect(body.version).toBe(3);
	});
});

// --- mapSession ---

describe("Bailian mapSession", () => {
	test("uses agent_id as plain string", () => {
		const bindings: SessionBindings = {
			agent_id: "agent_xxx",
			environment_id: "env_yyy",
			vault_ids: [],
			memory_store_ids: [],
		};
		const body = mapSession(bindings) as Record<string, unknown>;
		expect(body.agent).toBe("agent_xxx");
		expect(body.environment_id).toBe("env_yyy");
	});

	test("includes title when provided", () => {
		const bindings: SessionBindings = {
			agent_id: "agent_xxx",
			environment_id: "env_yyy",
			vault_ids: [],
			memory_store_ids: [],
			title: "Test session",
		};
		const body = mapSession(bindings) as Record<string, unknown>;
		expect(body.title).toBe("Test session");
	});

	test("omits optional fields when not provided", () => {
		const bindings: SessionBindings = {
			agent_id: "agent_xxx",
			environment_id: "env_yyy",
			vault_ids: [],
			memory_store_ids: [],
		};
		const body = mapSession(bindings) as Record<string, unknown>;
		expect(body.title).toBeUndefined();
		expect(body.metadata).toBeUndefined();
	});
});

// --- mapInitialEvents (task 5.2) ---

describe("Bailian mapInitialEvents", () => {
	test("maps user.message to Bailian input format", () => {
		const result = mapInitialEvents([{ type: "user.message", content: "hello" }]) as {
			input: Array<Record<string, unknown>>;
		};

		expect(result.input).toHaveLength(1);
		expect(result.input[0]!.role).toBe("user");
		expect(result.input[0]!.type).toBe("message");
		expect(result.input[0]!.content).toEqual([{ type: "text", text: "hello" }]);
	});

	test("maps system.message as user role message", () => {
		const result = mapInitialEvents([{ type: "system.message", content: "context info" }]) as {
			input: Array<Record<string, unknown>>;
		};

		expect(result.input).toHaveLength(1);
		expect(result.input[0]!.role).toBe("user");
		expect(result.input[0]!.content).toEqual([{ type: "text", text: "context info" }]);
	});

	test("filters out define_outcome events", () => {
		const result = mapInitialEvents([
			{ type: "user.message", content: "hello" },
			{ type: "user.define_outcome", description: "test" },
		]) as { input: Array<Record<string, unknown>> };

		expect(result.input).toHaveLength(1);
	});

	test("returns empty input for no supported events", () => {
		const result = mapInitialEvents([{ type: "user.define_outcome", description: "test" }]) as {
			input: Array<Record<string, unknown>>;
		};

		expect(result.input).toHaveLength(0);
	});
});

// --- mapEnvironment ---

describe("Bailian mapEnvironment", () => {
	test("maps environment with packages", () => {
		const decl: EnvironmentDecl = {
			config: {
				type: "cloud",
				packages: { pip: ["numpy"], apt: ["curl"] },
			},
		};
		const body = mapEnvironment("dev-env", decl, "my-proj") as Record<string, unknown>;

		expect(body.name).toBe("dev-env");
		expect(body.scope).toBe("organization");
		const config = body.config as Record<string, unknown>;
		expect(config.type).toBe("cloud");
		expect(config.packages).toEqual({ pip: ["numpy"], apt: ["curl"] });
		expect(config.networking).toEqual({ type: "unrestricted" });
	});

	test("injects agents metadata", () => {
		const decl: EnvironmentDecl = {
			config: { type: "cloud" },
			metadata: { team: "infra" },
		};
		const body = mapEnvironment("staging", decl, "proj") as Record<string, unknown>;
		const meta = body.metadata as Record<string, string>;
		expect(meta["agents.project"]).toBe("proj");
		expect(meta["agents.resource"]).toBe("staging");
		expect(meta.team).toBe("infra");
	});

	test("rejects 'limited' networking instead of silently widening it", () => {
		const decl: EnvironmentDecl = {
			config: { type: "cloud", networking: { type: "limited", allowed_hosts: ["api.github.com"] } },
		};
		// The real API rejects non-unrestricted networking; silently dropping the
		// restriction would widen a declared egress boundary, so we must throw.
		expect(() => mapEnvironment("locked", decl, "proj")).toThrow(/only supports networking.type 'unrestricted'/);
	});
});
