import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executePlan } from "../../src/internal/executor/executor.ts";
import { buildDependencyGraph } from "../../src/internal/graph/dependency.ts";
import { buildPlan } from "../../src/internal/planner/planner.ts";
import { ConflictError } from "../../src/internal/providers/base-client.ts";
import type { ProviderAdapter } from "../../src/internal/providers/interface.ts";
import { QoderAdapter } from "../../src/internal/providers/qoder/adapter.ts";
import { StateManager } from "../../src/internal/state/state-manager.ts";
import type { ProjectConfig } from "../../src/internal/types/config.ts";
import type { ExecutionPlan } from "../../src/internal/types/plan.ts";
import { contentHash } from "../../src/internal/utils/hash.ts";
import "../../src/internal/providers/all.ts";

function config(): ProjectConfig {
	return {
		version: "1",
		providers: { qoder: { api_key: "test" } },
		defaults: { provider: "qoder", identity: "chen" },
		identities: {
			chen: {
				external_id: "user_456",
				name: "Chen",
				metadata: { team: "engineering" },
			},
		},
		environments: {
			byoc: { environment_id: "env_byoc", config: { type: "self_hosted" } },
		},
		agents: {
			assistant: {
				model: { qoder: "auto" },
				instructions: "Help the user.",
				environment: "byoc",
				delivery: { qoder: { type: "forward" } },
			},
		},
		channels: {
			dingtalk: {
				agent: "assistant",
				type: "dingtalk",
				credentials: { client_id: "client", client_secret: "secret" },
			},
		},
	};
}

describe("Identity and Channel declarations", () => {
	test("plans Identity and Template before Channel", async () => {
		const desired = config();
		const graph = buildDependencyGraph(desired, ["qoder"]);
		expect([...graph.edges.get("qoder.channel.dingtalk")!].sort()).toEqual([
			"qoder.identity.chen",
			"qoder.template.assistant",
		]);

		const plan = await buildPlan(desired, { resources: [] });
		expect(plan.diagnostics).toEqual([]);
		const actions = plan.actions.map((action) => `${action.address.type}.${action.address.name}`);
		expect(actions.indexOf("identity.chen")).toBeLessThan(actions.indexOf("channel.dingtalk"));
		expect(actions.indexOf("template.assistant")).toBeLessThan(actions.indexOf("channel.dingtalk"));
	});

	test("plans an unambiguous Channel key rename as an in-place update", async () => {
		const desired = config();
		desired.channels = { "chimp-dingtalk": desired.channels!.dingtalk! };
		const plan = await buildPlan(desired, {
			resources: [
				{
					address: { type: "channel", name: "byoc-dingtalk", provider: "qoder" },
					remote_id: "channel_existing",
					content_hash: "old-hash",
					remote_snapshot: { channel_type: "dingtalk" },
				},
			],
		});

		const channelActions = plan.actions.filter((action) => action.address.type === "channel");
		expect(channelActions).toEqual([
			expect.objectContaining({
				action: "update",
				address: { type: "channel", name: "chimp-dingtalk", provider: "qoder" },
				previousAddress: { type: "channel", name: "byoc-dingtalk", provider: "qoder" },
			}),
		]);
	});

	test("does not guess a Channel rename when more than one same-type destination exists", async () => {
		const desired = config();
		desired.channels = {
			"chimp-dingtalk": desired.channels!.dingtalk!,
			"ops-dingtalk": { ...desired.channels!.dingtalk!, name: "Ops DingTalk" },
		};
		const plan = await buildPlan(desired, {
			resources: [
				{
					address: { type: "channel", name: "byoc-dingtalk", provider: "qoder" },
					remote_id: "channel_existing",
					content_hash: "old-hash",
					remote_snapshot: { channel_type: "dingtalk" },
				},
			],
		});

		const channelActions = plan.actions.filter((action) => action.address.type === "channel");
		expect(channelActions.map((action) => action.action)).toEqual(["create", "create", "delete"]);
		expect(channelActions.every((action) => action.previousAddress === undefined)).toBe(true);
	});

	test("uses a stored credential fingerprint to identify a Channel rename among multiple destinations", async () => {
		const desired = config();
		desired.channels = {
			"chimp-dingtalk": desired.channels!.dingtalk!,
			"ops-dingtalk": {
				...desired.channels!.dingtalk!,
				credentials: { client_id: "ops-client", client_secret: "ops-secret" },
			},
		};
		const plan = await buildPlan(desired, {
			resources: [
				{
					address: { type: "channel", name: "byoc-dingtalk", provider: "qoder" },
					remote_id: "channel_existing",
					content_hash: "old-hash",
					remote_snapshot: { channel_type: "dingtalk" },
					replacement_fingerprint: contentHash({
						channel_type: "dingtalk",
						credentials: { client_id: "client", client_secret: "secret" },
					}),
				},
			],
		});

		const renamed = plan.actions.find((action) => action.address.name === "chimp-dingtalk");
		expect(renamed).toMatchObject({
			action: "update",
			previousAddress: { type: "channel", name: "byoc-dingtalk", provider: "qoder" },
		});
		expect(plan.actions.find((action) => action.address.name === "ops-dingtalk")?.action).toBe("create");
	});

	test("keeps the old Channel dependencies when its in-place rename fails", async () => {
		const desired = config();
		desired.channels = { "chimp-dingtalk": desired.channels!.dingtalk! };
		const plan = await buildPlan(desired, {
			resources: [
				{
					address: { type: "identity", name: "byoc", provider: "qoder" },
					remote_id: "idn_old",
					content_hash: "old-identity-hash",
				},
				{
					address: { type: "channel", name: "byoc-dingtalk", provider: "qoder" },
					remote_id: "channel_existing",
					content_hash: "old-channel-hash",
					remote_snapshot: { channel_type: "dingtalk", identity_id: "idn_old" },
				},
			],
		});

		const identityDelete = plan.actions.find(
			(action) => action.action === "delete" && action.address.type === "identity" && action.address.name === "byoc",
		);
		expect(identityDelete?.dependencies).toContainEqual({
			type: "channel",
			name: "chimp-dingtalk",
			provider: "qoder",
		});
	});

	test("keeps unsupported Provider capabilities isolated", async () => {
		const desired = config();
		desired.providers = { claude: {} };
		desired.defaults = { provider: "claude", identity: "chen" };
		const plan = await buildPlan(desired, { resources: [] });
		expect(plan.diagnostics.some((item) => item.code === "claude.identity.unsupported")).toBe(true);
		expect(plan.diagnostics.some((item) => item.code === "claude.channel.unsupported")).toBe(true);
		expect(plan.actions.some((item) => item.address.type === "identity" || item.address.type === "channel")).toBe(
			false,
		);
	});

	test("records an external Identity reference without mutating or deleting it", async () => {
		const desired: ProjectConfig = {
			version: "1",
			providers: { qoder: {} },
			defaults: { provider: "qoder", identity: "chen" },
			identities: { chen: { identity_id: "idn_external" } },
		};
		const calls: string[] = [];
		const provider = {
			name: "qoder",
			findResource: async () => ({ id: "idn_external", type: "identity" }),
			createIdentity: async () => {
				calls.push("create");
				return { id: "unexpected", type: "identity" };
			},
			updateIdentity: async () => {
				calls.push("update");
				return { id: "unexpected", type: "identity" };
			},
			deleteIdentity: async () => calls.push("delete"),
		} as unknown as ProviderAdapter;
		const state = StateManager.initialize(join(tmpdir(), `identity-ref-${crypto.randomUUID()}.json`));
		const ctx = {
			config: desired,
			configPath: "/tmp/agents.yaml",
			providers: new Map([["qoder", provider]]),
			state,
		};

		const createPlan = await buildPlan(desired, state.getStateFile());
		await executePlan(createPlan, ctx);
		expect(state.getResource({ type: "identity", name: "chen", provider: "qoder" })).toMatchObject({
			remote_id: "idn_external",
			externally_managed: true,
		});

		ctx.config = { ...desired, defaults: { provider: "qoder" }, identities: undefined };
		const deletePlan = await buildPlan(ctx.config, state.getStateFile());
		await executePlan(deletePlan, ctx);
		expect(calls).toEqual([]);
	});

	test("executes an inferred Channel rename against the existing remote id and migrates state", async () => {
		const desired = config();
		desired.channels = { "chimp-dingtalk": desired.channels!.dingtalk! };
		const state = StateManager.initialize(join(tmpdir(), `channel-rename-${crypto.randomUUID()}.json`));
		state.setResource({
			address: { type: "identity", name: "chen", provider: "qoder" },
			remote_id: "idn_existing",
			content_hash: "identity-hash",
		});
		state.setResource({
			address: { type: "template", name: "assistant", provider: "qoder" },
			remote_id: "tmpl_existing",
			content_hash: "template-hash",
		});
		state.setResource({
			address: { type: "channel", name: "byoc-dingtalk", provider: "qoder" },
			remote_id: "channel_existing",
			content_hash: "channel-hash",
		});
		const calls: string[] = [];
		const provider = {
			name: "qoder",
			findResource: async () => null,
			updateChannel: async (id: string) => {
				calls.push(`update:${id}`);
				return { id, type: "channel" };
			},
			createChannel: async () => {
				calls.push("create");
				return { id: "unexpected", type: "channel" };
			},
			deleteChannel: async () => calls.push("delete"),
		} as unknown as ProviderAdapter;
		const plan: ExecutionPlan = {
			actions: [
				{
					action: "update",
					address: { type: "channel", name: "chimp-dingtalk", provider: "qoder" },
					previousAddress: { type: "channel", name: "byoc-dingtalk", provider: "qoder" },
					reason: "Channel key renamed",
					dependencies: [],
				},
			],
			diagnostics: [],
		};

		const result = await executePlan(plan, {
			config: desired,
			configPath: "/tmp/agents.yaml",
			providers: new Map([["qoder", provider]]),
			state,
		});

		expect(result.partial).toBe(false);
		expect(calls).toEqual(["update:channel_existing"]);
		expect(state.getResource({ type: "channel", name: "byoc-dingtalk", provider: "qoder" })).toBeUndefined();
		expect(state.getResource({ type: "channel", name: "chimp-dingtalk", provider: "qoder" })).toMatchObject({
			remote_id: "channel_existing",
			replacement_fingerprint: expect.any(String),
		});
	});

	test("skips deleting the old Identity when an inferred Channel rename fails", async () => {
		const desired = config();
		desired.channels = { "chimp-dingtalk": desired.channels!.dingtalk! };
		const state = StateManager.initialize(join(tmpdir(), `channel-rename-failure-${crypto.randomUUID()}.json`));
		for (const resource of [
			{
				address: { type: "identity" as const, name: "chen", provider: "qoder" },
				remote_id: "idn_new",
				content_hash: "new-identity-hash",
			},
			{
				address: { type: "template" as const, name: "assistant", provider: "qoder" },
				remote_id: "tmpl_existing",
				content_hash: "template-hash",
			},
			{
				address: { type: "identity" as const, name: "byoc", provider: "qoder" },
				remote_id: "idn_old",
				content_hash: "old-identity-hash",
			},
			{
				address: { type: "channel" as const, name: "byoc-dingtalk", provider: "qoder" },
				remote_id: "channel_existing",
				content_hash: "channel-hash",
			},
		]) {
			state.setResource(resource);
		}
		const calls: string[] = [];
		const provider = {
			name: "qoder",
			updateChannel: async () => {
				calls.push("update-channel");
				throw new Error("update failed");
			},
			createChannel: async () => ({ id: "unexpected", type: "channel" }),
			deleteIdentity: async () => calls.push("delete-identity"),
		} as unknown as ProviderAdapter;
		const channelAddress = { type: "channel" as const, name: "chimp-dingtalk", provider: "qoder" };
		const plan: ExecutionPlan = {
			actions: [
				{
					action: "update",
					address: channelAddress,
					previousAddress: { type: "channel", name: "byoc-dingtalk", provider: "qoder" },
					reason: "Channel key renamed",
					dependencies: [],
				},
				{
					action: "delete",
					address: { type: "identity", name: "byoc", provider: "qoder" },
					reason: "removed",
					dependencies: [channelAddress],
				},
			],
			diagnostics: [],
		};

		const result = await executePlan(plan, {
			config: desired,
			configPath: "/tmp/agents.yaml",
			providers: new Map([["qoder", provider]]),
			state,
		});

		expect(result.results.map((item) => item.status)).toEqual(["failed", "skipped"]);
		expect(calls).toEqual(["update-channel"]);
		expect(state.getResource({ type: "identity", name: "byoc", provider: "qoder" })?.remote_id).toBe("idn_old");
	});

	test("reports a Qoder credential conflict as credential ownership instead of a reserved name", async () => {
		const desired = config();
		const state = StateManager.initialize(join(tmpdir(), `channel-conflict-${crypto.randomUUID()}.json`));
		state.setResource({
			address: { type: "identity", name: "chen", provider: "qoder" },
			remote_id: "idn_existing",
			content_hash: "identity-hash",
		});
		state.setResource({
			address: { type: "template", name: "assistant", provider: "qoder" },
			remote_id: "tmpl_existing",
			content_hash: "template-hash",
		});
		const provider = {
			name: "qoder",
			findResource: async () => null,
			createChannel: async () => {
				throw new ConflictError(
					409,
					JSON.stringify({
						error: { code: "CHANNEL_CREDENTIAL_CONFLICT", message: "Credential is already in use." },
					}),
					"Qoder API",
				);
			},
			updateChannel: async () => ({ id: "unexpected", type: "channel" }),
		} as unknown as ProviderAdapter;
		const plan: ExecutionPlan = {
			actions: [
				{
					action: "create",
					address: { type: "channel", name: "dingtalk", provider: "qoder" },
					reason: "missing",
					dependencies: [],
				},
			],
			diagnostics: [],
		};

		const result = await executePlan(plan, {
			config: desired,
			configPath: "/tmp/agents.yaml",
			providers: new Map([["qoder", provider]]),
			state,
		});

		expect(result.results[0]?.error?.message).toContain("credentials are already used by another Channel");
		expect(result.results[0]?.error?.message).not.toContain("recently deleted");
	});
});

describe("Qoder Identity and Channel adapter", () => {
	test("maps managed Identity lifecycle to Forward endpoints", async () => {
		const calls: Array<{ method: string; path: string; body?: unknown }> = [];
		const adapter = new QoderAdapter("pt-test") as any;
		adapter.forwardClient = {
			get: async (path: string) => {
				calls.push({ method: "GET", path });
				return { id: "idn_1", metadata: { old: "value" } };
			},
			post: async (path: string, body: unknown) => {
				calls.push({ method: "POST", path, body });
				return { id: "idn_1", type: "identity" };
			},
			delete: async (path: string) => calls.push({ method: "DELETE", path }),
		};

		const decl = { external_id: "user_456", name: "Chen", metadata: { team: "engineering" } } as const;
		await adapter.createIdentity("chen", decl);
		await adapter.updateIdentity("idn_1", "chen", decl);
		await adapter.deleteIdentity("idn_1");

		expect(calls[0]).toMatchObject({
			method: "POST",
			path: "/identities",
			body: { external_id: "user_456", name: "Chen", enabled: true, metadata: { team: "engineering" } },
		});
		expect(calls[2]).toMatchObject({
			method: "POST",
			path: "/identities/idn_1",
			body: { metadata: { team: "engineering", old: "" } },
		});
		expect(calls.at(-1)).toEqual({ method: "DELETE", path: "/identities/idn_1" });
	});

	test("maps logical references and generic Channel fields to Qoder wire fields", async () => {
		const calls: Array<{ method: string; path: string; body?: any }> = [];
		const adapter = new QoderAdapter("pt-test") as any;
		adapter.forwardClient = {
			post: async (path: string, body: unknown) => {
				calls.push({ method: "POST", path, body });
				return { id: "channel_1", type: "channel" };
			},
			delete: async (path: string) => calls.push({ method: "DELETE", path }),
		};

		await adapter.createChannel(
			"dingtalk",
			{
				agent: "assistant",
				type: "dingtalk",
				credentials: { client_id: "client", client_secret: "secret" },
				options: { include_thinking: true },
			},
			{ identity_id: "idn_1", agent_id: "tmpl_1" },
		);

		expect(calls[0]).toMatchObject({
			method: "POST",
			path: "/channels",
			body: {
				identity_id: "idn_1",
				template_id: "tmpl_1",
				channel_type: "dingtalk",
				name: "dingtalk",
				enabled: true,
				channel_config: {
					credentials: { client_id: "client", client_secret: "secret" },
					response_options: { include_tool_calls: false, include_thinking: true },
				},
			},
		});
	});
});
