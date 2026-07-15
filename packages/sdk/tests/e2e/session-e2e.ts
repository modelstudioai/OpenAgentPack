// Full live e2e (MUTATING, auto-cleanup): exercises each provider's real adapter
// across the session lifecycle and captures REAL event JSON to verify the
// secondary findings (stop_reason shape, error shape, event-type coverage).
//
// Claude: 0 agents exist → create a cheap Haiku agent (cleaned up), reuse env "demo".
//   Also asserts adapter.sendSessionMessage (broken bare-array body) throws 400 on a
//   REAL session, then triggers the turn with the correct {events:[...]} body.
// Qoder: reuse existing "Hello World Agent" + ready env "dev"; adapter.sendSessionMessage
//   is correct, so it triggers the turn directly. Only a disposable session is created.
//
// Pre-existing resources are NEVER deleted; only resources created here are cleaned up.

import { ApiError } from "../../src/internal/providers/base-client.ts";
import { ClaudeAdapter } from "../../src/internal/providers/claude/adapter.ts";
import { ClaudeClient } from "../../src/internal/providers/claude/client.ts";
import type { ProviderAdapter } from "../../src/internal/providers/interface.ts";
import { QoderAdapter } from "../../src/internal/providers/qoder/adapter.ts";
import type { AgentDecl } from "../../src/internal/types/config.ts";
import type { ProviderSessionEvent } from "../../src/internal/types/session-event.ts";

const CLAUDE_ENV_ID = "env_017iTg6A5hQipZC38tNJJ3SJ"; // existing "demo"
const QODER_AGENT_ID = "agent_019eb662cfd57844bbda0c0851d3b638"; // existing "Hello World Agent"
const QODER_ENV_ID = "env_019eb0eca682727a820b5ea6e55ba93e"; // existing "dev" (ready)

function fmtEvent(e: ProviderSessionEvent): string {
	const parts = [`norm=${e.type}`, `raw_type=${e.raw_type}`];
	if (e.status !== undefined) parts.push(`status=${e.status}`);
	if (e.stop_reason !== undefined) parts.push(`stopReason(normalized)=${JSON.stringify(e.stop_reason)}`);
	if (e.raw_type === "session.status_idle" || "stop_reason" in e.raw)
		parts.push(`stopReason(RAW)=${JSON.stringify(e.raw.stop_reason)}`);
	if (e.tool_name !== undefined) parts.push(`tool_name=${JSON.stringify(e.tool_name)}`);
	if (e.tool_input !== undefined) parts.push(`tool_input=${JSON.stringify(e.tool_input).slice(0, 60)}`);
	if (e.raw_type === "session.error" || e.type === "error")
		parts.push(`errNorm=${JSON.stringify(e.content)} errRAW=${JSON.stringify(e.raw.error)}`);
	if (e.content !== undefined && e.type === "message") parts.push(`content=${JSON.stringify(e.content).slice(0, 80)}`);
	return parts.join("  ");
}

// Open the SSE stream and collect normalized events until a terminal idle event
// or the deadline. Returns whatever was captured.
async function collectStream(
	adapter: ProviderAdapter,
	sessionId: string,
	maxMs: number,
): Promise<ProviderSessionEvent[]> {
	const out: ProviderSessionEvent[] = [];
	const it = adapter.streamSessionEvents(sessionId)[Symbol.asyncIterator]();
	const deadline = Date.now() + maxMs;
	try {
		while (true) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) break;
			let timeoutId: ReturnType<typeof setTimeout> | undefined;
			const timeout = new Promise<"timeout">((r) => {
				timeoutId = setTimeout(() => r("timeout"), remaining);
			});
			let next: IteratorResult<ProviderSessionEvent> | "timeout";
			try {
				next = await Promise.race([it.next(), timeout]);
			} finally {
				if (timeoutId) clearTimeout(timeoutId);
			}
			if (next === "timeout") break;
			if (next.done) break;
			out.push(next.value);
			if (next.value.raw_type === "session.status_idle") break;
		}
	} finally {
		try {
			await it.return?.(undefined);
		} catch {
			/* ignore */
		}
	}
	return out;
}

async function runClaude(): Promise<string> {
	const key = Bun.env.ANTHROPIC_API_KEY;
	if (!key) return "CLAUDE: no key, skipped";
	const adapter = new ClaudeAdapter(key, undefined, "agents-e2e");
	const directClient = new ClaudeClient({ apiKey: key });
	const log: string[] = ["\n========== CLAUDE e2e =========="];
	let agentId: string | null = null;
	let sessionId: string | null = null;

	try {
		// 1. create a cheap agent (no existing agents to reuse)
		const decl = {
			model: "claude-haiku-4-5-20251001",
			instructions: "You are a test bot. Reply with exactly the single word: PONG. Never use any tools.",
			description: "agents e2e ephemeral agent",
		} as unknown as AgentDecl;
		const agent = await adapter.createAgent("agents-e2e-agent", decl, { skill_ids: [] });
		agentId = agent.id;
		log.push(`1. createAgent → ${agentId} (v${agent.version})`);

		// 2. create session
		const session = await adapter.createSession({
			agent_id: agentId!,
			environment_id: CLAUDE_ENV_ID,
			vault_ids: [],
			memory_store_ids: [],
			title: "agents e2e",
		});
		sessionId = session.id;
		log.push(`2. createSession → ${sessionId} (status=${session.status})`);

		// 3. PROVE the send bug on a REAL session via the adapter (broken bare-array body)
		try {
			await adapter.sendSessionMessage(sessionId!, "ping");
			log.push(`3. adapter.sendSessionMessage → ❗ UNEXPECTEDLY SUCCEEDED (bug may be fixed?)`);
		} catch (e) {
			if (e instanceof ApiError)
				log.push(
					`3. adapter.sendSessionMessage (current code) → HTTP ${e.statusCode}: ${e.responseBody.replace(/\s+/g, " ").slice(0, 150)}`,
				);
			else log.push(`3. adapter.sendSessionMessage threw: ${(e as Error).message.slice(0, 150)}`);
		}

		// 4. trigger the turn with the CORRECT body, capturing the live stream concurrently
		const streamP = collectStream(adapter, sessionId!, 60_000);
		await new Promise((r) => setTimeout(r, 300)); // let the stream connect first
		await directClient.post(`/sessions/${sessionId}/events`, {
			events: [{ type: "user.message", content: [{ type: "text", text: "ping" }] }],
		});
		log.push(`4. triggered turn with correct {events:[...]} body`);
		const streamed = await streamP;
		log.push(`5. streamed ${streamed.length} live SSE event(s):`);
		for (const e of streamed) log.push(`     · ${fmtEvent(e)}`);

		// 6. list persisted events (authoritative; also tests listSessionEvents)
		const listed = await adapter.listSessionEvents(sessionId!, { limit: 100 });
		log.push(`6. listSessionEvents → ${listed.events.length} event(s), has_more=${listed.has_more}:`);
		for (const e of listed.events) log.push(`     · ${fmtEvent(e)}`);
	} catch (e) {
		log.push(
			`✗ ERROR: ${e instanceof ApiError ? `HTTP ${e.statusCode}: ${e.responseBody.slice(0, 200)}` : (e as Error).message}`,
		);
	} finally {
		if (sessionId) {
			try {
				await adapter.deleteSession(sessionId);
				log.push(`🧹 archived session ${sessionId}`);
			} catch (e) {
				log.push(`⚠ session cleanup failed: ${(e as Error).message.slice(0, 100)}`);
			}
		}
		if (agentId) {
			try {
				await adapter.deleteAgent(agentId);
				log.push(`🧹 archived agent ${agentId}`);
			} catch (e) {
				log.push(`⚠ agent cleanup failed: ${(e as Error).message.slice(0, 100)}`);
			}
		}
	}
	return log.join("\n");
}

async function runQoder(): Promise<string> {
	const key = Bun.env.QODER_PAT;
	if (!key) return "QODER: no key, skipped";
	const adapter = new QoderAdapter(key, undefined, "agents-e2e");
	const log: string[] = ["\n========== QODER e2e =========="];
	let sessionId: string | null = null;

	try {
		const session = await adapter.createSession({
			agent_id: QODER_AGENT_ID,
			environment_id: QODER_ENV_ID,
			vault_ids: [],
			memory_store_ids: [],
			title: "agents e2e",
		});
		sessionId = session.id;
		log.push(`1. createSession → ${sessionId} (status=${session.status})`);

		// 2. trigger via the adapter's send (Qoder's mapSendMessage is correct), stream concurrently
		const streamP = collectStream(adapter, sessionId!, 90_000);
		await new Promise((r) => setTimeout(r, 300));
		await adapter.sendSessionMessage(sessionId!, "Reply with exactly the single word PONG.");
		log.push(`2. adapter.sendSessionMessage → accepted (triggered turn)`);
		const streamed = await streamP;
		log.push(`3. streamed ${streamed.length} live SSE event(s):`);
		for (const e of streamed) log.push(`     · ${fmtEvent(e)}`);

		const listed = await adapter.listSessionEvents(sessionId!, { limit: 100 });
		log.push(`4. listSessionEvents → ${listed.events.length} event(s), has_more=${listed.has_more}:`);
		for (const e of listed.events) log.push(`     · ${fmtEvent(e)}`);
	} catch (e) {
		log.push(
			`✗ ERROR: ${e instanceof ApiError ? `HTTP ${e.statusCode}: ${e.responseBody.slice(0, 200)}` : (e as Error).message}`,
		);
	} finally {
		if (sessionId) {
			try {
				await adapter.deleteSession(sessionId);
				log.push(`🧹 deleted session ${sessionId}`);
			} catch (e) {
				log.push(`⚠ session cleanup failed: ${(e as Error).message.slice(0, 100)}`);
			}
		}
	}
	return log.join("\n");
}

console.log("Full live e2e (mutating, auto-cleanup)\n");
console.log(await runClaude());
console.log(await runQoder());
console.log("\nDone.");
