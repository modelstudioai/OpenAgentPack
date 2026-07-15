#!/usr/bin/env bun

/**
 * 使用 agents 部署的基础设施创建 Session 并与 Agent 对话。
 *
 * 用法:
 *   QODER_PAT=<token> bun run examples/qoder-full/run-session.ts
 */

import { resolve } from "node:path";
import { StateManager } from "../../packages/sdk/src/index.ts";

const PAT = process.env.QODER_PAT;
if (!PAT) {
	console.error("Error: QODER_PAT environment variable is required");
	process.exit(1);
}

const BASE = "https://api.qoder.com/api/v1/cloud";
const headers = {
	Authorization: `Bearer ${PAT}`,
	"Content-Type": "application/json",
};

// Load state to get remote IDs
const statePath = resolve(import.meta.dir, "agents.state.json");
const state = await StateManager.load(statePath);

const agent = state.getResource({ type: "agent", name: "researcher", provider: "qoder" });
const env = state.getResource({ type: "environment", name: "dev", provider: "qoder" });
const memStore = state.getResource({ type: "memory_store", name: "project-kb", provider: "qoder" });

if (!agent || !env) {
	console.error("Error: Run 'agents apply' first to create infrastructure");
	process.exit(1);
}

console.log(`\n🏗️  Infrastructure:`);
console.log(`   Agent:        ${agent.remote_id}`);
console.log(`   Environment:  ${env.remote_id}`);
console.log(`   Memory Store: ${memStore?.remote_id ?? "none"}`);

// 1. Create Session
console.log(`\n📡 Creating session...`);
const sessionBody: Record<string, unknown> = {
	agent: agent.remote_id,
	environment_id: env.remote_id,
	title: "agents integration test",
};
if (memStore) {
	sessionBody.resources = [{ type: "memory_store", memory_store_id: memStore.remote_id }];
}

const sessionRes = await fetch(`${BASE}/sessions`, {
	method: "POST",
	headers,
	body: JSON.stringify(sessionBody),
});

if (!sessionRes.ok) {
	console.error(`Failed to create session: ${sessionRes.status} ${await sessionRes.text()}`);
	process.exit(1);
}

const session = (await sessionRes.json()) as { id: string; status: string };
console.log(`   Session ID: ${session.id}`);
console.log(`   Status:     ${session.status}`);

// 2. Send a message
const message = "What is 2 + 2? Reply with just the number.";
console.log(`\n💬 Sending: "${message}"`);

const eventRes = await fetch(`${BASE}/sessions/${session.id}/events`, {
	method: "POST",
	headers,
	body: JSON.stringify({
		events: [{ type: "user.message", content: [{ type: "text", text: message }] }],
	}),
});

if (!eventRes.ok) {
	console.error(`Failed to send event: ${eventRes.status} ${await eventRes.text()}`);
	process.exit(1);
}

console.log(`   Message accepted (HTTP ${eventRes.status})`);

// 3. Stream SSE events until idle
console.log(`\n📥 Streaming response...`);

const sseRes = await fetch(`${BASE}/sessions/${session.id}/events/stream`, {
	headers: { Authorization: `Bearer ${PAT}`, Accept: "text/event-stream" },
});

if (!sseRes.ok || !sseRes.body) {
	console.error(`Failed to connect SSE: ${sseRes.status}`);
	process.exit(1);
}

const reader = sseRes.body.getReader();
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
		if (line.startsWith("event: ")) {
			const eventType = line.slice(7);
			if (eventType === "session.status_idle") {
				done = true;
			}
		}
		if (line.startsWith("data: ")) {
			try {
				const data = JSON.parse(line.slice(6));
				if (data.type === "agent.message" && data.content) {
					const text = Array.isArray(data.content)
						? data.content.map((c: { text?: string }) => c.text ?? "").join("")
						: data.content;
					console.log(`\n🤖 Agent: ${text}`);
				} else if (data.type === "agent.tool_use") {
					console.log(`   🔧 Tool: ${data.name}(${JSON.stringify(data.input).slice(0, 80)})`);
				} else if (data.type === "session.status_idle") {
					const usage = data.usage;
					if (usage) {
						console.log(`\n📊 Usage: ${usage.input_tokens} in / ${usage.output_tokens} out`);
					}
				}
			} catch {}
		}
	}
}

reader.releaseLock();
console.log(`\n✅ Session complete: ${session.id}\n`);
