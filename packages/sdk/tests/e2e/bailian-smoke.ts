import { BailianAdapter } from "../../src/internal/providers/bailian/adapter.ts";
import type { ResolvedAgentRefs, ResolvedDeploymentRefs } from "../../src/internal/providers/interface.ts";
import type { AgentDecl, DeploymentDecl, EnvironmentDecl } from "../../src/internal/types/config.ts";

const API_KEY = process.env.DASHSCOPE_API_KEY;
const BASE_URL = process.env.BAILIAN_BASE_URL;
const WORKSPACE_ID = process.env.BAILIAN_WORKSPACE_ID;

if (!API_KEY || !BASE_URL || !WORKSPACE_ID) {
	console.log("⏭  DASHSCOPE_API_KEY, BAILIAN_BASE_URL, or BAILIAN_WORKSPACE_ID not set; skipping live smoke test");
	process.exit(0);
}

const adapter = new BailianAdapter(API_KEY, WORKSPACE_ID, BASE_URL, "agents-smoke-test");

const created: { envId?: string; agentId?: string; sessionIds: string[] } = { sessionIds: [] };

async function waitForIdle(id: string, timeoutMs = 30_000): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const s = await adapter.getSession(id);
		if (s.status === "idle" || s.status === "terminated") return;
		await Bun.sleep(1000);
	}
	console.log(`   ⚠  session ${id} did not reach idle within ${timeoutMs}ms, attempting archive`);
}

async function safeDeleteSession(id: string): Promise<void> {
	try {
		await waitForIdle(id);
		await adapter.deleteSession(id);
	} catch {
		// If DELETE fails (still running), fall back to archive
		const res = await fetch(`${BASE_URL}/sessions/${id}/archive`, {
			method: "POST",
			headers: { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" },
		});
		if (!res.ok) console.log(`   ⚠  archive also failed for ${id}: ${res.status}`);
	}
}

async function run() {
	console.log("=== Bailian Adapter Live Smoke Test ===\n");

	// 1. validate
	console.log("1. validate()...");
	await adapter.validate();
	console.log("   ✅ validate passed\n");

	// 2. create environment
	console.log("2. createEnvironment()...");
	const envDecl: EnvironmentDecl = {
		description: "Agents smoke test environment",
		config: {
			type: "cloud",
			packages: { pip: ["requests"] },
		},
		metadata: { test: "smoke" },
	};
	const env = await adapter.createEnvironment("agents-smoke-env", envDecl);
	created.envId = env.id!;
	console.log(`   ✅ created environment: ${env.id} (type=${env.type})\n`);

	// 3. create agent
	console.log("3. createAgent()...");
	const agentDecl: AgentDecl = {
		model: "qwen3.7-max",
		instructions: "You are a smoke test agent. Reply with exactly: SMOKE_OK",
		description: "Agents smoke test agent",
		tools: { builtin: ["bash"] },
	};
	const refs: ResolvedAgentRefs = { skill_ids: [] };
	const agent = await adapter.createAgent("agents-smoke-agent", agentDecl, refs);
	created.agentId = agent.id!;
	console.log(`   ✅ created agent: ${agent.id} (version=${agent.version})\n`);

	// 4. update agent (version bump)
	console.log("4. updateAgent()...");
	const updatedAgent = await adapter.updateAgent(
		agent.id!,
		"agents-smoke-agent",
		{ ...agentDecl, instructions: "Updated: reply with SMOKE_OK_V2" },
		refs,
	);
	console.log(`   ✅ updated agent: version ${agent.version} → ${updatedAgent.version}\n`);

	// 5. findResource
	console.log("5. findResource()...");
	const found = await adapter.findResource("agent", "agents-smoke-agent");
	console.log(`   ✅ findResource('agent', 'agents-smoke-agent'): ${found ? `found ${found.id}` : "not found"}\n`);

	// 6. create session
	console.log("6. createSession()...");
	const session = await adapter.createSession({
		agent_id: agent.id!,
		environment_id: env.id!,
		vault_ids: [],
		memory_store_ids: [],
		title: "Agents Smoke Test Session",
	});
	created.sessionIds.push(session.id);
	console.log(`   ✅ created session: ${session.id} (status=${session.status})\n`);

	// 7. getSession
	console.log("7. getSession()...");
	const gotSession = await adapter.getSession(session.id);
	console.log(`   ✅ getSession: id=${gotSession.id}, status=${gotSession.status}, agent_id=${gotSession.agent_id}\n`);

	// 8. listSessions
	console.log("8. listSessions()...");
	const listed = await adapter.listSessions({ agent_id: agent.id!, limit: 5 });
	console.log(`   ✅ listSessions: found ${listed.sessions.length} session(s), has_more=${listed.has_more}\n`);

	// 9. emulated deployment
	console.log("9. Deployment (emulated)...");
	const deployRefs: ResolvedDeploymentRefs = {
		agent_id: agent.id!,
		environment_id: env.id!,
		vault_ids: [],
		memory_store_ids: {},
	};
	const deployDecl: DeploymentDecl = {
		agent: "agents-smoke-agent",
		initial_events: [{ type: "user.message", content: "Hello smoke test" }],
		description: "Smoke test deployment",
	};

	const deployResult = await adapter.createDeployment("smoke-deploy", deployDecl, deployRefs, "/fake");
	console.log(`   ✅ createDeployment: id=${deployResult.id} (emulated, expected null)`);

	const runResult = await adapter.runDeployment({
		id: null,
		name: "smoke-deploy",
		decl: deployDecl,
		refs: deployRefs,
		basePath: "/fake/project.yaml",
	});
	console.log(`   ✅ runDeployment: session_id=${runResult.session_id}\n`);

	if (runResult.session_id) {
		created.sessionIds.push(runResult.session_id);
	}

	// 10. cleanup
	console.log("\n10. Cleanup...");

	for (const sid of created.sessionIds) {
		await safeDeleteSession(sid);
		console.log(`   🧹 deleted session: ${sid}`);
	}

	if (created.agentId) {
		await adapter.deleteAgent(created.agentId);
		console.log(`   🧹 archived agent: ${created.agentId}`);
	}

	if (created.envId) {
		await adapter.deleteEnvironment(created.envId);
		console.log(`   🧹 deleted environment: ${created.envId}`);
	}

	console.log("\n=== All smoke tests passed! ===");
}

run().catch(async (err) => {
	console.error("\n❌ Smoke test failed:", err.message);

	// Best-effort cleanup
	console.log("\n🧹 Attempting cleanup after failure...");
	for (const sid of created.sessionIds) {
		try {
			await safeDeleteSession(sid);
		} catch {}
	}
	try {
		if (created.agentId) await adapter.deleteAgent(created.agentId);
	} catch {}
	try {
		if (created.envId) await adapter.deleteEnvironment(created.envId);
	} catch {}

	process.exit(1);
});
