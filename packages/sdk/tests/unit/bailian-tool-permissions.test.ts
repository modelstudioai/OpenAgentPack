import { afterEach, describe, expect, test } from "bun:test";
import { validateProjectConfig } from "../../src/internal/core/validate-config.ts";
import { resolveProjectConfigFromObject } from "../../src/internal/parser/index.ts";
import { BailianAdapter } from "../../src/internal/providers/bailian/adapter.ts";
import { setDefaultFetch } from "../../src/internal/transport.ts";
import type { AgentDecl, ProjectConfig } from "../../src/internal/types/config.ts";
import "../../src/internal/providers/bailian/index.ts";

afterEach(() => setDefaultFetch(undefined));

const adapter = () => new BailianAdapter("sk-fixture", undefined, "https://provider.example.test/api/v1/agentstudio");
const refs = { skill_ids: [] };

describe("Bailian builtin-tool approval contract", () => {
	test.each([
		"allow",
		"ask",
	] as const)("validates and sends default %s with tool overrides on create and update", async (permission) => {
		const override = permission === "ask" ? "allow" : "ask";
		const agent: AgentDecl = {
			model: "qwen3.7-max",
			instructions: "Approval test",
			tools: {
				builtin: ["read", "write"],
				default_permission: permission,
				permissions: { Read: override },
			},
		};
		const config: ProjectConfig = {
			version: "1",
			providers: { bailian: {} },
			defaults: { provider: "bailian" },
			agents: { assistant: agent },
		};
		expect(validateProjectConfig(config).filter((item) => item.severity === "error")).toEqual([]);
		const posts: Record<string, unknown>[] = [];
		setDefaultFetch(async (_input, init) => {
			if (!init?.method || init.method === "GET") return Response.json({ id: "agent_test", version: 1 });
			const body = JSON.parse(String(init.body)) as Record<string, unknown>;
			posts.push(body);
			return Response.json({ ...body, id: "agent_test", version: 2 });
		});
		const provider = adapter();
		await provider.createAgent("assistant", agent, refs);
		await provider.updateAgent("agent_test", "assistant", agent, refs);
		expect(posts).toHaveLength(2);
		for (const body of posts) {
			expect(body.tools).toEqual([
				{
					type: "builtin_toolkit",
					default_config: { enabled: false, permission_policy: { type: `always_${permission}` } },
					configs: [
						{ name: "read", enabled: true, permission_policy: { type: `always_${override}` } },
						{ name: "write", enabled: true },
					],
				},
			]);
		}
		expect(posts[1]?.version).toBe(1);
		const desired = provider.normalizeDesiredResource("agent", "assistant", agent, refs);
		const noOverride = provider.normalizeDesiredResource(
			"agent",
			"assistant",
			{
				...agent,
				tools: { builtin: ["read", "write"], default_permission: permission },
			},
			refs,
		);
		expect(desired).not.toEqual(noOverride);
		const explicit = provider.normalizeDesiredResource(
			"agent",
			"assistant",
			{
				...agent,
				tools: { ...agent.tools!, permissions: { Read: override, write: permission } },
			},
			refs,
		);
		expect(desired).toEqual(explicit);
	});

	test.each([
		{ defaultPermission: "ask", permissions: { bash: "allow" } },
		{ defaultPermission: "allow", permissions: { bash: "ask" } },
		{ defaultPermission: undefined, permissions: { bash: "ask" } },
	] as const)("导出并再次发布保留默认策略和单工具覆盖：%j", async ({ defaultPermission, permissions }) => {
		const original: AgentDecl = {
			model: "auto",
			instructions: "Approval round trip",
			tools: { builtin: ["read", "bash"], default_permission: defaultPermission, permissions },
		};
		let remote: Record<string, unknown>;
		const published: Record<string, unknown>[] = [];
		setDefaultFetch(async (_input, init) => {
			if (!init?.method || init.method === "GET") return Response.json({ data: [remote] });
			const body = JSON.parse(String(init.body)) as Record<string, unknown>;
			published.push(body);
			remote = { ...body, id: "agent_fixture", version: 1 };
			return Response.json(remote);
		});
		const provider = adapter();
		await provider.createAgent("assistant", original, refs);
		const [exported] = await provider.exportResources("agent");
		const loaded = await resolveProjectConfigFromObject(
			{ version: "1", providers: { bailian: {} }, agents: { assistant: exported!.decl } },
			{ projectName: "approval-round-trip", resolveEnv: false },
		);
		const restored = loaded.config.agents!.assistant!;
		expect(restored.tools).toEqual(original.tools);
		await provider.createAgent("assistant", restored, refs);
		expect(published[1]?.tools).toEqual(published[0]?.tools);
	});

	test("导出保留显式禁用全部工具，不把禁用项的审批覆盖重新启用", async () => {
		setDefaultFetch(async () =>
			Response.json({
				data: [
					{
						id: "agent_fixture",
						name: "assistant",
						model: { id: "auto" },
						system: "",
						tools: [
							{
								type: "builtin_toolkit",
								default_config: { enabled: false, permission_policy: { type: "always_ask" } },
								configs: [{ name: "bash", enabled: false, permission_policy: { type: "always_allow" } }],
							},
						],
					},
				],
			}),
		);
		const [exported] = await adapter().exportResources("agent");
		expect(exported?.decl.tools).toEqual({ builtin: [], default_permission: "ask" });
	});

	test("无法枚举默认启用的工具时，拒绝有损导出审批策略", async () => {
		setDefaultFetch(async () =>
			Response.json({
				data: [
					{
						id: "agent_fixture",
						name: "assistant",
						model: { id: "auto" },
						system: "",
						tools: [
							{
								type: "builtin_toolkit",
								default_config: { enabled: true, permission_policy: { type: "always_ask" } },
								configs: [],
							},
						],
					},
				],
			}),
		);
		await expect(adapter().exportResources("agent")).rejects.toThrow("sync.agent.tool_permissions.implicit_tools");
	});

	test("keeps allow-only baselines unchanged and detects remote approval drift", async () => {
		const provider = adapter();
		const agent: AgentDecl = { model: "qwen3.7-max", instructions: "", tools: { builtin: ["read"] } };
		const desired = provider.normalizeDesiredResource("agent", "assistant", agent, refs) as Record<string, unknown>;
		expect(desired.tools).toEqual({ builtin: ["read"] });
		const readComparable = async (toolkit: Record<string, unknown>) => {
			setDefaultFetch(async () =>
				Response.json({
					id: "agent_test",
					name: "assistant",
					model: { id: "qwen3.7-max" },
					system: "",
					tools: [toolkit],
				}),
			);
			return (await provider.readComparableResource("agent", "agent_test", "assistant"))?.comparable;
		};
		const allowed = await readComparable({ type: "builtin_toolkit", configs: [{ name: "read", enabled: true }] });
		const explicit = await readComparable({
			type: "builtin_toolkit",
			default_config: { permission_policy: { type: "always_ask" } },
			configs: [{ name: "read", enabled: true, permission_policy: { type: "always_allow" } }],
		});
		expect(allowed).toEqual(explicit);
		const approval = await readComparable({
			type: "builtin_toolkit",
			default_config: { permission_policy: { type: "always_ask" } },
			configs: [{ name: "read", enabled: true }],
		});
		expect(approval).not.toEqual(allowed);
	});
});
