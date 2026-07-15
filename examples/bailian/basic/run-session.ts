#!/usr/bin/env bun

/**
 * Talk to the agent provisioned by `agents apply` against Bailian AgentStudio.
 *
 * Prerequisites (read from .env at the repo root, Bun auto-loads it):
 *   DASHSCOPE_API_KEY    — Bearer token (sk-...)
 *   BAILIAN_WORKSPACE_ID — workspace id (llm-...)
 *
 * Usage:
 *   bun run bin/agents.ts apply -f examples/bailian/basic/agents.yaml -y
 *   bun examples/bailian/basic/run-session.ts
 *
 * Targets PRODUCTION. The base URL is derived from BAILIAN_WORKSPACE_ID,
 * matching basic/agents.yaml (which has no base_url).
 */

import { resolve } from "node:path";
import { StateManager } from "../../../packages/sdk/src/index.ts";

const API_KEY = process.env.DASHSCOPE_API_KEY;
if (!API_KEY) {
	console.error("Error: DASHSCOPE_API_KEY environment variable is required");
	process.exit(1);
}

const WORKSPACE_ID = process.env.BAILIAN_WORKSPACE_ID;
if (!WORKSPACE_ID) {
	console.error("Error: BAILIAN_WORKSPACE_ID environment variable is required");
	process.exit(1);
}

const BASE = `https://${WORKSPACE_ID}.cn-beijing.maas.aliyuncs.com/api/v1/agentstudio`;
const json = { Authorization: `Bearer ${API_KEY}`, "Content-Type": "application/json" };

// Resolve remote IDs from the state file written by `agents apply`.
const statePath = resolve(import.meta.dir, "agents.state.json");
const state = await StateManager.load(statePath);
const agent = state.getResource({ type: "agent", name: "assistant", provider: "bailian" });
const env = state.getResource({ type: "environment", name: "dev", provider: "bailian" });

if (!agent?.remote_id || !env?.remote_id) {
	console.error("Error: run 'agents apply -f examples/bailian/basic/agents.yaml -y' first");
	process.exit(1);
}

console.log(`\nInfrastructure:`);
console.log(`  Agent:        ${agent.remote_id}`);
console.log(`  Environment:  ${env.remote_id}`);

// 1. Create a session. On Bailian `agent` is a plain id string.
console.log(`\nCreating session...`);
const sessionRes = await fetch(`${BASE}/sessions`, {
	method: "POST",
	headers: json,
	body: JSON.stringify({
		agent: agent.remote_id,
		environment_id: env.remote_id,
		title: "agents basic example",
	}),
});
if (!sessionRes.ok) {
	console.error(`Failed to create session: ${sessionRes.status} ${await sessionRes.text()}`);
	process.exit(1);
}
const session = (await sessionRes.json()) as { id: string };
console.log(`  Session ID:   ${session.id}`);

// 2. Send the user message. The stream endpoint only emits once a turn exists,
//    so the message must be sent before opening the stream.
const message = "What is 2 + 2? Reply with just the number.";
console.log(`\nSending: "${message}"`);
const eventRes = await fetch(`${BASE}/sessions/${session.id}/events`, {
	method: "POST",
	headers: json,
	body: JSON.stringify({
		input: [{ role: "user", type: "message", content: [{ type: "text", text: message }] }],
	}),
});
if (!eventRes.ok) {
	console.error(`Failed to send event: ${eventRes.status} ${await eventRes.text()}`);
	await fetch(`${BASE}/sessions/${session.id}`, { method: "DELETE", headers: json });
	process.exit(1);
}

// 3. Stream the response. Every frame is `event: message`; the real type lives in
//    data.type. The turn is complete when a session_status=idle frame arrives
//    (the server streams this run's events from the point we connect).
console.log(`\nStreaming response...`);
const ac = new AbortController();
const timeout = setTimeout(() => ac.abort(), 90_000);

const textOf = (content: unknown): string =>
	Array.isArray(content) ? content.map((c: { text?: string }) => c.text ?? "").join("") : "";

try {
	const streamRes = await fetch(`${BASE}/sessions/${session.id}/events/stream`, {
		headers: { Authorization: `Bearer ${API_KEY}`, Accept: "text/event-stream" },
		signal: ac.signal,
	});
	if (!streamRes.ok || !streamRes.body) {
		throw new Error(`Failed to open stream: ${streamRes.status}`);
	}

	const reader = streamRes.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let done = false;

	while (!done) {
		const { value, done: streamDone } = await reader.read();
		if (streamDone) break;

		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split("\n");
		buffer = lines.pop()!;

		for (const line of lines) {
			if (!line.startsWith("data:")) continue;
			let data: Record<string, unknown>;
			try {
				data = JSON.parse(line.slice(line.indexOf(":") + 1).trim());
			} catch {
				continue;
			}

			switch (data.type) {
				case "message":
					if (data.role === "assistant") console.log(`\nAgent: ${textOf(data.content)}`);
					break;
				case "reasoning":
					console.log(`  (thinking) ${textOf(data.content)}`);
					break;
				case "tool_call":
					console.log(
						`  Tool call: ${
							Array.isArray(data.content) ? ((data.content[0] as { data?: { name?: string } })?.data?.name ?? "?") : "?"
						}`,
					);
					break;
				case "tool_call_output":
					console.log(`  Tool output received`);
					break;
				case "error":
					console.error(`  Error: ${JSON.stringify(data)}`);
					break;
				case "session_status": {
					const status = Array.isArray(data.content)
						? (data.content[0] as { data?: { session_status?: string } })?.data?.session_status
						: undefined;
					if (status === "idle") done = true;
					break;
				}
			}
		}
	}
	reader.releaseLock();
} catch (err) {
	if ((err as Error).name === "AbortError") {
		console.error(`\nTimed out after 90s waiting for the agent to finish.`);
	} else {
		console.error(`\n${(err as Error).message}`);
	}
} finally {
	clearTimeout(timeout);
	// Clean up the remote session.
	await fetch(`${BASE}/sessions/${session.id}`, { method: "DELETE", headers: json });
}

console.log(`\nSession complete: ${session.id}\n`);
