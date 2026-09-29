// Explicit opt-in Multi-Agent live probe (implementation plan step 10).
//
// Usage:
//   bun packages/sdk/tests/e2e/multiagent-live.ts qoder-managed
//   bun packages/sdk/tests/e2e/multiagent-live.ts qoder-forward
//   bun packages/sdk/tests/e2e/multiagent-live.ts bailian
//
// One external worker + one coordinator per Managed run. Verifies that `{agent_id}`
// resolves without local state, then create → read (roster) → run → clear → cleanup.
// Qoder Forward retains its project-logical-name coverage because `{agent_id}` is
// intentionally unsupported there. All temporary resources are
// named `oap-ma-live-${timestamp}*` and deleted/archived in `finally`. Logs never
// include tokens, full user metadata, or listings of non-test resources.

import { resolveAgentRefs, resolveTemplateRefs } from "../../src/internal/executor/resolver.ts";
import { BailianAdapter } from "../../src/internal/providers/bailian/adapter.ts";
import type { ComparableRemoteResource, ProviderAdapter } from "../../src/internal/providers/interface.ts";
import { QoderAdapter } from "../../src/internal/providers/qoder/adapter.ts";
import type { IStateManager } from "../../src/internal/state/state-manager.ts";
import { StateManager } from "../../src/internal/state/state-manager.ts";
import type { AgentDecl, EnvironmentDecl, ProjectConfig } from "../../src/internal/types/config.ts";
import type { ProviderSessionEvent } from "../../src/internal/types/session-event.ts";

const MODE = process.argv[2];
const MODES = ["qoder-managed", "qoder-forward", "bailian"] as const;
type Mode = (typeof MODES)[number];

if (!MODE || !MODES.includes(MODE as Mode)) {
	console.log(`Usage: bun packages/sdk/tests/e2e/multiagent-live.ts <${MODES.join("|")}>`);
	process.exit(2);
}

const ts = Date.now().toString(36);
const projectName = `oap-ma-live-${ts}`;
const workerName = `${projectName}-worker`;
const coordName = `${projectName}-coord`;
const envName = `${projectName}-env`;
const identityName = `${projectName}-identity`;

const QODER_PAT = process.env.QODER_PAT;
const DASHSCOPE_API_KEY = process.env.DASHSCOPE_API_KEY;
const BAILIAN_WORKSPACE_ID = process.env.BAILIAN_WORKSPACE_ID;
const BAILIAN_BASE_URL = process.env.BAILIAN_BASE_URL?.trim() || undefined;

if (MODE.startsWith("qoder") && !QODER_PAT) {
	console.log("⏭  QODER_PAT not set; skipping qoder multiagent live probe");
	process.exit(0);
}
if (MODE === "bailian" && (!DASHSCOPE_API_KEY || !BAILIAN_WORKSPACE_ID)) {
	console.log("⏭  DASHSCOPE_API_KEY or BAILIAN_WORKSPACE_ID not set; skipping bailian multiagent live probe");
	process.exit(0);
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(`assertion failed: ${message}`);
}

function errText(err: unknown): string {
	return err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
}

interface ProbeState {
	sessionId?: string;
	coordId?: string;
	workerId?: string;
	envId?: string;
	identityId?: string;
}

const probe: ProbeState = {};

function setState(
	state: IStateManager,
	type: "agent" | "template" | "environment",
	name: string,
	remoteId: string,
): void {
	state.setResource({
		address: { provider: "qoder", type, name },
		remote_id: remoteId,
		...(type === "environment" ? { api_mode: "forward" as const } : {}),
		content_hash: "",
	});
}

function rosterOf(remote: ComparableRemoteResource | null): unknown {
	assert(remote, "readComparableResource returned null for the coordinator");
	return (remote.comparable as { multiagent?: unknown }).multiagent;
}

async function readRoster(
	adapter: ProviderAdapter,
	type: "agent" | "template",
	id: string,
	name: string,
	decl?: AgentDecl,
): Promise<unknown> {
	const remote = await adapter.readComparableResource(type, id, name, decl);
	return rosterOf(remote);
}

function assertRosterEqual(actual: unknown, memberRemoteId: string, label: string): void {
	const want = JSON.stringify({ type: "coordinator", member_ids: [memberRemoteId] });
	const got = JSON.stringify(actual ?? null);
	assert(got === want, `${label}: roster mismatch — got ${got}, want ${want}`);
}

interface TurnSummary {
	status: string;
	eventCounts: Record<string, number>;
	threadedEvents: number;
	sawAssistantMessage: boolean;
	sawError: boolean;
}

function summarizeEvents(events: ProviderSessionEvent[]): {
	counts: Record<string, number>;
	threaded: number;
	sawAssistantMessage: boolean;
	sawError: boolean;
} {
	const counts: Record<string, number> = {};
	let threaded = 0;
	let sawAssistantMessage = false;
	let sawError = false;
	for (const e of events) {
		const key = e.raw_type || e.type;
		counts[key] = (counts[key] ?? 0) + 1;
		if (e.session_thread_id) threaded += 1;
		if (e.type === "message" && e.raw_type !== "user.message" && e.role !== "user") sawAssistantMessage = true;
		if (e.type === "error") sawError = true;
	}
	return { counts, threaded, sawAssistantMessage, sawError };
}

async function runTurn(
	adapter: ProviderAdapter,
	sessionId: string,
	prompt: string,
	timeoutMs: number,
): Promise<TurnSummary> {
	await adapter.sendSessionMessage(sessionId, prompt);
	const deadline = Date.now() + timeoutMs;
	let summary: TurnSummary = {
		status: "unknown",
		eventCounts: {},
		threadedEvents: 0,
		sawAssistantMessage: false,
		sawError: false,
	};
	let prevCount = -1;
	while (Date.now() < deadline) {
		await Bun.sleep(3000);
		const session = await adapter.getSession(sessionId);
		const listed = await adapter.listSessionEvents(sessionId, { limit: 100 });
		const { counts, threaded, sawAssistantMessage, sawError } = summarizeEvents(listed.events);
		summary = { status: session.status, eventCounts: counts, threadedEvents: threaded, sawAssistantMessage, sawError };
		const settled = (sawAssistantMessage || sawError) && listed.events.length === prevCount;
		if (settled || session.status === "terminated") break;
		prevCount = listed.events.length;
	}
	return summary;
}

async function waitForIdle(adapter: ProviderAdapter, id: string, timeoutMs = 60_000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const s = await adapter.getSession(id);
		if (s.status === "idle" || s.status === "terminated") return;
		await Bun.sleep(2000);
	}
	console.log(`   ⚠  session ${id} did not reach idle within ${timeoutMs}ms`);
}

async function safeDeleteSession(adapter: ProviderAdapter, id: string): Promise<void> {
	try {
		await adapter.deleteSession(id);
		return;
	} catch {
		// Retry after waiting for the turn to finish.
	}
	try {
		await waitForIdle(adapter, id);
		await adapter.deleteSession(id);
	} catch (err) {
		console.log(`   ⚠  session cleanup failed for ${id}: ${errText(err)}`);
	}
}

function baseAgentDecl(instructions: string): AgentDecl {
	return {
		model: "ultimate",
		instructions,
		description: "oap multiagent live probe",
		tools: { builtin: ["Read", "Glob", "Grep"] },
	};
}

function forwardAgentDecl(instructions: string, environment: string): AgentDecl {
	return { ...baseAgentDecl(instructions), environment, delivery: { qoder: { type: "forward" } } };
}

const ENV_DECL: EnvironmentDecl = {
	description: "oap multiagent live probe environment",
	config: { type: "cloud", networking: { type: "unrestricted" } },
};

// ---------------------------------------------------------------------------
// qoder-managed
// ---------------------------------------------------------------------------

async function runQoderManaged(): Promise<void> {
	const adapter = new QoderAdapter(QODER_PAT!, undefined, projectName);
	const state = StateManager.initialize(`/tmp/${projectName}-state.json`);

	const workerDecl = baseAgentDecl("You are a live-probe worker. Answer questions with one short sentence.");
	const workerConfig: ProjectConfig = {
		version: "1",
		providers: { qoder: {} },
		agents: { [workerName]: workerDecl },
	};

	console.log("1. validate()...");
	await adapter.validate();
	console.log("   ✅ validate passed\n");

	console.log("2. createEnvironment()...");
	const env = await adapter.createEnvironment(envName, ENV_DECL);
	probe.envId = env.id!;
	console.log(`   ✅ created environment: ${env.id}\n`);

	console.log("3. createAgent() external worker...");
	const workerRefs = resolveAgentRefs(workerName, workerConfig, "qoder", state);
	const worker = await adapter.createAgent(workerName, workerDecl, workerRefs);
	probe.workerId = worker.id!;
	console.log(`   ✅ created external worker agent: ${worker.id} (not written to local state)\n`);

	const coordDecl: AgentDecl = {
		...baseAgentDecl(
			"You are a live-probe coordinator with one external worker. Delegate the user's question to the worker, then return its answer verbatim.",
		),
		multiagent: { type: "coordinator", agents: [{ agent_id: worker.id! }] },
	};
	const config: ProjectConfig = {
		version: "1",
		providers: { qoder: {} },
		agents: { [coordName]: coordDecl },
	};
	const clearedConfig: ProjectConfig = {
		version: "1",
		providers: { qoder: {} },
		agents: { [coordName]: { ...coordDecl, multiagent: undefined } },
	};

	console.log("4. createAgent() coordinator with multiagent roster...");
	const coordRefs = resolveAgentRefs(coordName, config, "qoder", state);
	assert(coordRefs.multiagent, "resolveAgentRefs did not compute the multiagent roster");
	assert(coordRefs.multiagent.members.length === 1, "roster should have exactly one member");
	assert(coordRefs.multiagent.members[0]!.remote_id === worker.id, "roster member remote_id mismatch");
	assert(coordRefs.multiagent.members[0]!.logical_name === undefined, "external member must have no logical name");
	const coord = await adapter.createAgent(coordName, coordDecl, coordRefs);
	probe.coordId = coord.id!;
	console.log(`   ✅ created coordinator agent: ${coord.id} (version=${coord.version})\n`);

	console.log("5. readComparableResource() — roster wired with member id...");
	const roster = await readRoster(adapter, "agent", coord.id!, coordName, coordDecl);
	assertRosterEqual(roster, worker.id!, "managed create read-back");
	console.log(`   ✅ remote roster = ${JSON.stringify(roster)}\n`);

	console.log("6. createSession() + sendSessionMessage() on the coordinator...");
	const session = await adapter.createSession({
		agent_id: coord.id!,
		environment_id: env.id!,
		vault_ids: [],
		memory_store_ids: [],
		title: `${projectName} session`,
	});
	probe.sessionId = session.id;
	const turn = await runTurn(adapter, session.id, "What is 2+2? Reply with just the number.", 120_000);
	console.log(
		`   ✅ session ${session.id}: status=${turn.status}, events=${JSON.stringify(turn.eventCounts)}, threaded=${turn.threadedEvents}\n`,
	);
	assert(turn.sawAssistantMessage, "coordinator session produced no assistant message");

	console.log("7. updateAgent() without multiagent — roster must clear (multiagent: null)...");
	const clearedRefs = resolveAgentRefs(coordName, clearedConfig, "qoder", state);
	assert(!clearedRefs.multiagent, "cleared refs still carry a roster");
	await adapter.updateAgent(coord.id!, coordName, clearedConfig.agents![coordName]!, clearedRefs);
	const clearedRoster = await readRoster(adapter, "agent", coord.id!, coordName, clearedConfig.agents![coordName]!);
	assert(clearedRoster === undefined, `cleared roster should be absent, got ${JSON.stringify(clearedRoster ?? null)}`);
	console.log("   ✅ remote roster cleared\n");
}

// ---------------------------------------------------------------------------
// qoder-forward
// ---------------------------------------------------------------------------

async function runQoderForward(): Promise<void> {
	const adapter = new QoderAdapter(QODER_PAT!, undefined, projectName);
	const state = StateManager.initialize(`/tmp/${projectName}-state.json`);

	const workerDecl = forwardAgentDecl(
		"You are a live-probe worker. Answer questions with one short sentence.",
		envName,
	);
	const coordDecl: AgentDecl = {
		...forwardAgentDecl(
			"You are a live-probe coordinator with one worker. Delegate the user's question to the worker, then return its answer verbatim.",
			envName,
		),
		multiagent: { type: "coordinator", agents: [workerName] },
	};
	const config: ProjectConfig = {
		version: "1",
		providers: { qoder: {} },
		environments: { [envName]: ENV_DECL },
		agents: { [workerName]: workerDecl, [coordName]: coordDecl },
	};
	const clearedConfig: ProjectConfig = {
		version: "1",
		providers: { qoder: {} },
		environments: { [envName]: ENV_DECL },
		agents: { [workerName]: workerDecl, [coordName]: { ...coordDecl, multiagent: undefined } },
	};

	console.log("1. validate()...");
	await adapter.validate();
	console.log("   ✅ validate passed\n");

	console.log("2. createIdentity()...");
	const identity = await adapter.createIdentity(identityName, {
		external_id: identityName,
		name: identityName,
		enabled: true,
	});
	probe.identityId = identity.id!;
	console.log(`   ✅ created identity: ${identity.id}\n`);

	console.log("3. createEnvironment(forward)...");
	const env = await adapter.createEnvironment(envName, ENV_DECL, "forward");
	probe.envId = env.id!;
	setState(state, "environment", envName, env.id!);
	console.log(`   ✅ created forward environment: ${env.id}\n`);

	console.log("4. createTemplate() worker...");
	const workerRefs = resolveTemplateRefs(workerName, config, "qoder", state);
	const worker = await adapter.createTemplate(workerName, workerDecl, workerRefs);
	probe.workerId = worker.id!;
	setState(state, "template", workerName, worker.id!);
	console.log(`   ✅ created worker template: ${worker.id}\n`);

	console.log("5. createTemplate() coordinator with multiagent roster...");
	const coordRefs = resolveTemplateRefs(coordName, config, "qoder", state);
	assert(coordRefs.multiagent, "resolveTemplateRefs did not compute the multiagent roster");
	assert(coordRefs.multiagent.members[0]!.remote_id === worker.id, "roster member remote_id mismatch");
	assert(coordRefs.multiagent.members[0]!.resource_type === "template", "forward roster members must be templates");
	const coord = await adapter.createTemplate(coordName, coordDecl, coordRefs);
	probe.coordId = coord.id!;
	console.log(`   ✅ created coordinator template: ${coord.id}\n`);

	console.log("6. readComparableResource() — roster wired with template_id...");
	const roster = await readRoster(adapter, "template", coord.id!, coordName);
	assertRosterEqual(roster, worker.id!, "forward create read-back");
	console.log(`   ✅ remote roster = ${JSON.stringify(roster)}\n`);

	console.log("7. createSession(forward) + sendSessionMessage() on the coordinator...");
	const session = await adapter.createSession({
		delivery: "forward",
		template_id: coord.id!,
		identity_id: probe.identityId,
		title: `${projectName} session`,
	});
	probe.sessionId = session.id;
	const turn = await runTurn(adapter, session.id, "What is 2+2? Reply with just the number.", 120_000);
	console.log(
		`   ✅ session ${session.id}: status=${turn.status}, events=${JSON.stringify(turn.eventCounts)}, threaded=${turn.threadedEvents}\n`,
	);
	assert(turn.sawAssistantMessage, "coordinator session produced no assistant message");

	console.log("8. updateTemplate() without multiagent — roster must clear (multiagent: null)...");
	const clearedRefs = resolveTemplateRefs(coordName, clearedConfig, "qoder", state);
	assert(!clearedRefs.multiagent, "cleared refs still carry a roster");
	await adapter.updateTemplate(coord.id!, coordName, clearedConfig.agents![coordName]!, clearedRefs);
	const clearedRoster = await readRoster(adapter, "template", coord.id!, coordName);
	assert(clearedRoster === undefined, `cleared roster should be absent, got ${JSON.stringify(clearedRoster ?? null)}`);
	console.log("   ✅ remote roster cleared\n");
}

// ---------------------------------------------------------------------------
// bailian
// ---------------------------------------------------------------------------

async function runBailian(): Promise<void> {
	const adapter = new BailianAdapter(DASHSCOPE_API_KEY!, BAILIAN_WORKSPACE_ID!, BAILIAN_BASE_URL, projectName);
	const state = StateManager.initialize(`/tmp/${projectName}-state.json`);

	const workerDecl: AgentDecl = {
		model: "qwen3.7-max",
		instructions: "You are a live-probe worker. Answer questions with one short sentence.",
		description: "oap multiagent live probe worker",
	};
	const workerConfig: ProjectConfig = {
		version: "1",
		providers: { bailian: {} },
		agents: { [workerName]: workerDecl },
	};
	const envDecl: EnvironmentDecl = {
		description: "oap multiagent live probe environment",
		config: { type: "cloud" },
	};

	console.log("1. validate()...");
	await adapter.validate();
	console.log("   ✅ validate passed\n");

	console.log("2. createEnvironment()...");
	const env = await adapter.createEnvironment(envName, envDecl);
	probe.envId = env.id!;
	console.log(`   ✅ created environment: ${env.id}\n`);

	console.log("3. createAgent() external worker...");
	const workerRefs = resolveAgentRefs(workerName, workerConfig, "bailian", state);
	const worker = await adapter.createAgent(workerName, workerDecl, workerRefs);
	probe.workerId = worker.id!;
	console.log(`   ✅ created external worker agent: ${worker.id} (not written to local state)\n`);

	const coordDecl: AgentDecl = {
		model: "qwen3.7-max",
		instructions:
			"You are a live-probe coordinator with one external worker. Delegate the user's question to the worker, then return its answer verbatim.",
		description: "oap multiagent live probe coordinator",
		multiagent: { type: "coordinator", agents: [{ agent_id: worker.id! }] },
	};
	const config: ProjectConfig = {
		version: "1",
		providers: { bailian: {} },
		agents: { [coordName]: coordDecl },
	};
	const clearedConfig: ProjectConfig = {
		version: "1",
		providers: { bailian: {} },
		agents: { [coordName]: { ...coordDecl, multiagent: undefined } },
	};

	console.log("4. createAgent() coordinator with multiagent roster...");
	const coordRefs = resolveAgentRefs(coordName, config, "bailian", state);
	assert(coordRefs.multiagent, "resolveAgentRefs did not compute the multiagent roster");
	assert(coordRefs.multiagent.members[0]!.remote_id === worker.id, "roster member remote_id mismatch");
	assert(coordRefs.multiagent.members[0]!.logical_name === undefined, "external member must have no logical name");
	const coord = await adapter.createAgent(coordName, coordDecl, coordRefs);
	probe.coordId = coord.id!;
	console.log(`   ✅ created coordinator agent: ${coord.id} (version=${coord.version})\n`);

	console.log("5. readComparableResource() — roster wired with member id...");
	const roster = await readRoster(adapter, "agent", coord.id!, coordName);
	assertRosterEqual(roster, worker.id!, "bailian create read-back");
	console.log(`   ✅ remote roster = ${JSON.stringify(roster)}\n`);

	console.log("6. createSession() + sendSessionMessage() on the coordinator...");
	const session = await adapter.createSession({
		agent_id: coord.id!,
		environment_id: env.id!,
		vault_ids: [],
		memory_store_ids: [],
		title: `${projectName} session`,
	});
	probe.sessionId = session.id;
	const turn = await runTurn(adapter, session.id, "What is 2+2? Reply with just the number.", 150_000);
	console.log(
		`   ✅ session ${session.id}: status=${turn.status}, events=${JSON.stringify(turn.eventCounts)}, threaded=${turn.threadedEvents}\n`,
	);
	assert(turn.sawAssistantMessage, "coordinator session produced no assistant message");

	console.log("7. updateAgent() without multiagent — roster must clear (empty coordinator)...");
	const clearedRefs = resolveAgentRefs(coordName, clearedConfig, "bailian", state);
	assert(!clearedRefs.multiagent, "cleared refs still carry a roster");
	await adapter.updateAgent(coord.id!, coordName, clearedConfig.agents![coordName]!, clearedRefs);
	const clearedRoster = await readRoster(adapter, "agent", coord.id!, coordName);
	assert(clearedRoster === undefined, `cleared roster should be absent, got ${JSON.stringify(clearedRoster ?? null)}`);
	console.log("   ✅ remote roster cleared\n");
}

// ---------------------------------------------------------------------------
// runner + cleanup
// ---------------------------------------------------------------------------

async function cleanup(): Promise<void> {
	const mode = MODE as Mode;
	const adapter: ProviderAdapter =
		mode === "bailian"
			? new BailianAdapter(DASHSCOPE_API_KEY!, BAILIAN_WORKSPACE_ID!, BAILIAN_BASE_URL, projectName)
			: new QoderAdapter(QODER_PAT!, undefined, projectName);

	console.log(`\n🧹 Cleanup (${mode}) — destroy order is the reverse of creation`);
	if (probe.sessionId) {
		await safeDeleteSession(adapter, probe.sessionId);
		console.log(`   🧹 removed session: ${probe.sessionId}`);
	}
	if (probe.coordId) {
		try {
			if (mode === "qoder-forward") await adapter.archiveTemplate!(probe.coordId);
			else await adapter.deleteAgent(probe.coordId);
			console.log(`   🧹 ${mode === "qoder-forward" ? "archived" : "archived/deleted"} coordinator: ${probe.coordId}`);
		} catch (err) {
			console.log(`   ⚠  coordinator cleanup failed for ${probe.coordId}: ${errText(err)}`);
		}
	}
	if (probe.workerId) {
		try {
			if (mode === "qoder-forward") await adapter.archiveTemplate!(probe.workerId);
			else await adapter.deleteAgent(probe.workerId);
			console.log(`   🧹 ${mode === "qoder-forward" ? "archived" : "archived/deleted"} worker: ${probe.workerId}`);
		} catch (err) {
			console.log(`   ⚠  worker cleanup failed for ${probe.workerId}: ${errText(err)}`);
		}
	}
	if (probe.identityId && mode === "qoder-forward") {
		try {
			await adapter.deleteIdentity!(probe.identityId);
			console.log(`   🧹 deleted identity: ${probe.identityId}`);
		} catch (err) {
			console.log(`   ⚠  identity cleanup failed for ${probe.identityId}: ${errText(err)}`);
		}
	}
	if (probe.envId) {
		try {
			// Qoder rejects environment deletion with "referenced by N session(s)" unless cascade=true,
			// even when N=0 — the probe's sessions are already deleted by this point.
			await adapter.deleteEnvironment(probe.envId, true, mode === "qoder-forward" ? "forward" : "managed");
			console.log(`   🧹 deleted environment: ${probe.envId}`);
		} catch (err) {
			console.log(`   ⚠  environment cleanup failed for ${probe.envId}: ${errText(err)}`);
		}
	}
}

async function main(): Promise<void> {
	console.log(`=== Multi-Agent Live Probe: ${MODE} (prefix ${projectName}) ===\n`);
	if (MODE === "qoder-managed") await runQoderManaged();
	else if (MODE === "qoder-forward") await runQoderForward();
	else await runBailian();
	console.log(`=== Multi-Agent live probe (${MODE}) passed! ===`);
}

main()
	.catch((err) => {
		console.error(`\n❌ Multi-Agent live probe (${MODE}) failed: ${errText(err)}`);
		process.exitCode = 1;
	})
	.finally(() => cleanup());
