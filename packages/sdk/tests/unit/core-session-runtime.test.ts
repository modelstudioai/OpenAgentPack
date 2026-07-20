import { describe, expect, test } from "bun:test";
import type { ProjectRuntimeContext } from "../../src/internal/core/project-runtime.ts";
import {
	createSessionForAgent,
	sendSessionMessageAndCollectEvents,
	startSessionRun,
	streamMessageEvents,
} from "../../src/internal/core/session-runtime.ts";
import { BailianAdapter } from "../../src/internal/providers/bailian/adapter.ts";
import { ClaudeAdapter } from "../../src/internal/providers/claude/adapter.ts";
import type { ProviderAdapter } from "../../src/internal/providers/interface.ts";
import { QoderAdapter } from "../../src/internal/providers/qoder/adapter.ts";
import { StateManager } from "../../src/internal/state/state-manager.ts";
import type { ProjectConfig } from "../../src/internal/types/config.ts";
import type { ProviderSessionInfo } from "../../src/internal/types/session.ts";
import type { ProviderSessionEvent } from "../../src/internal/types/session-event.ts";

function session(id = "sess_1", status = "idle"): ProviderSessionInfo {
	return {
		id,
		agent_id: "agent_1",
		environment_id: "env_1",
		status,
		vault_ids: [],
		memory_store_ids: [],
		created_at: "2026-01-01T00:00:00Z",
		updated_at: "2026-01-01T00:00:01Z",
		attributes: {},
	};
}

function config(): ProjectConfig {
	return {
		version: "1",
		providers: { qoder: { api_key: "test" } },
		defaults: { provider: "qoder" },
		environments: {
			dev: { config: { type: "cloud" } },
		},
		agents: {
			assistant: {
				model: "qwen3",
				instructions: "help",
				environment: "dev",
			},
		},
	};
}

function state(): StateManager {
	const s = StateManager.initialize("/tmp/core-session-runtime-state.json");
	s.setResource({
		address: { type: "agent", name: "assistant", provider: "qoder" },
		remote_id: "agent_1",
		version: 2,
		content_hash: "h",
	});
	s.setResource({
		address: { type: "environment", name: "dev", provider: "qoder" },
		remote_id: "env_1",
		content_hash: "h",
	});
	return s;
}

function adapter(
	name: string,
	calls: string[],
	eventResume: boolean,
	events: ProviderSessionEvent[] = [{ type: "status", raw_type: "session.status_idle", status: "idle", raw: {} }],
): ProviderAdapter {
	return {
		name,
		eventResume,
		validate: async () => {},
		findResource: async () => null,
		createEnvironment: async () => ({ id: "env_1", type: "environment" }),
		updateEnvironment: async () => ({ id: "env_1", type: "environment" }),
		deleteEnvironment: async () => {},
		createVault: async () => ({ id: "vault_1", type: "vault" }),
		deleteVault: async () => {},
		createSkill: async () => ({ id: "skill_1", type: "skill" }),
		updateSkill: async () => ({ id: "skill_1", type: "skill" }),
		deleteSkill: async () => {},
		createAgent: async () => ({ id: "agent_1", type: "agent" }),
		updateAgent: async () => ({ id: "agent_1", type: "agent" }),
		deleteAgent: async () => {},
		createMemoryStore: async () => ({ id: "ms_1", type: "memory_store" }),
		deleteMemoryStore: async () => {},
		createDeployment: async () => ({ id: null, type: "deployment" }),
		updateDeployment: async () => ({ id: null, type: "deployment" }),
		deleteDeployment: async () => {},
		runDeployment: async () => ({ session_id: "sess_1" }),
		getDeployment: async () => ({ id: null, status: "ok" }),
		createSession: async () => {
			calls.push("createSession");
			return session();
		},
		listSessions: async () => ({ sessions: [session()], has_more: false }),
		getSession: async () => {
			calls.push("getSession");
			return session("sess_1", "idle");
		},
		deleteSession: async () => {},
		sendSessionMessage: async (_id, message) => {
			calls.push(`send:${message}`);
			return "evt_user";
		},
		streamSessionEvents: async function* (_id, options) {
			calls.push(`stream:${options?.after_id ?? "none"}`);
			for (const event of events) yield event;
		},
		listSessionEvents: async (_id, options) => {
			calls.push(`list:${options?.after_id ?? "none"}`);
			return { events, has_more: false };
		},
	};
}

function ctx(provider: ProviderAdapter): ProjectRuntimeContext {
	return {
		configPath: "/tmp/agents.yaml",
		statePath: "/tmp/agents.state.json",
		projectName: "test",
		config: { ...config(), _resolved: true },
		state: state(),
		providers: new Map([[provider.name, provider]]),
	};
}

describe("core session runtime", () => {
	test("starts a Forward session with the caller's explicit Identity", async () => {
		const forwardConfig = config();
		forwardConfig.agents!.assistant!.delivery = { qoder: { type: "forward" } };
		const forwardState = StateManager.initialize("/tmp/core-forward-session-runtime-state.json");
		forwardState.setResource({
			address: { type: "template", name: "assistant", provider: "qoder" },
			remote_id: "tmpl_1",
			content_hash: "h",
		});
		let receivedBindings: Record<string, unknown> | undefined;
		const provider = {
			...adapter("qoder", [], true),
			createSession: async (bindings: Record<string, unknown>) => {
				receivedBindings = bindings;
				return session("sess_forward");
			},
		};
		const runtime: ProjectRuntimeContext = {
			configPath: "/tmp/agents.yaml",
			statePath: "/tmp/agents.state.json",
			projectName: "test",
			config: { ...forwardConfig, _resolved: true },
			state: forwardState,
			providers: new Map([["qoder", provider as ProviderAdapter]]),
		};

		const run = await startSessionRun(runtime, "do work", {
			agent: "assistant",
			identityId: "idn_runtime_user",
		});

		expect(run.session.id).toBe("sess_forward");
		expect(receivedBindings).toMatchObject({
			delivery: "forward",
			template_id: "tmpl_1",
			identity_id: "idn_runtime_user",
		});
	});

	test("startRun creates a new session and streams events (resume adapter)", async () => {
		const calls: string[] = [];
		const provider = adapter("qoder", calls, true);
		const run = await startSessionRun(ctx(provider), "do work", { agent: "assistant" });

		expect(run.session.id).toBe("sess_1");
		expect(run.agentName).toBe("assistant");

		const seen: ProviderSessionEvent[] = [];
		for await (const event of run.events) seen.push(event);

		expect(seen[0]?.status).toBe("idle");
		expect(calls).toEqual(["createSession", "send:do work", "stream:evt_user"]);
	});

	test("forwards explicit tunnel overrides when creating a session", async () => {
		let tunnelId: string | undefined;
		const provider = {
			...adapter("qoder", [], true),
			createSession: async (bindings: { tunnel_id?: string }) => {
				tunnelId = bindings.tunnel_id;
				return session();
			},
		};

		await createSessionForAgent(ctx(provider), {
			agent: "assistant",
			tunnelId: "tnl_override",
		});

		expect(tunnelId).toBe("tnl_override");
	});

	test("eventResume=true streams after the created event id", async () => {
		const calls: string[] = [];
		const provider = adapter("p", calls, true);
		const seen: ProviderSessionEvent[] = [];

		for await (const event of streamMessageEvents(provider, "sess_existing", "continue")) {
			seen.push(event);
		}

		expect(seen.length).toBe(1);
		expect(calls).toEqual(["send:continue", "stream:evt_user"]);
	});

	test("eventResume=false connects before send and polls without afterId", async () => {
		const calls: string[] = [];
		const provider = adapter("p", calls, false);

		const result = await sendSessionMessageAndCollectEvents(provider, "sess_1", "poll", {
			pollIntervalMs: 1,
			pollTimeoutMs: 100,
		});

		expect(result.terminalStatus).toBe("idle");
		expect(result.result.events[0]?.status).toBe("idle");
		expect(calls).toEqual(["send:poll", "getSession", "list:none"]);
	});

	test("eventResume=true lists events after the created event id", async () => {
		const calls: string[] = [];
		const provider = adapter("p", calls, true);

		const result = await sendSessionMessageAndCollectEvents(provider, "sess_1", "poll", {
			pollIntervalMs: 1,
			pollTimeoutMs: 100,
		});

		expect(result.eventId).toBe("evt_user");
		expect(result.terminalStatus).toBe("idle");
		expect(calls).toEqual(["send:poll", "list:evt_user"]);
	});
});

describe("provider eventResume declarations", () => {
	test("qoder resumes; bailian and claude do not", () => {
		expect(new QoderAdapter("k").eventResume).toBe(true);
		expect(new BailianAdapter("k", "ws").eventResume).toBe(false);
		expect(new ClaudeAdapter("k").eventResume).toBe(false);
	});
});
