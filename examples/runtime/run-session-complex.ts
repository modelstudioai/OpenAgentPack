#!/usr/bin/env bun

/**
 * 更复杂的 Session 示例：让 Agent 使用工具，测试 skill + memory_store 集成。
 */

import { resolve } from "node:path";
import { StateManager } from "../../packages/sdk/src/index.ts";

const PAT = process.env.QODER_PAT!;
const BASE = "https://api.qoder.com/api/v1/cloud";
const headers = {
	Authorization: `Bearer ${PAT}`,
	"Content-Type": "application/json",
};

const statePath = resolve(import.meta.dir, "agents.state.json");
const state = await StateManager.load(statePath);

const agent = state.getResource({ type: "agent", name: "researcher", provider: "qoder" })!;
const env = state.getResource({ type: "environment", name: "dev", provider: "qoder" })!;
const memStore = state.getResource({ type: "memory_store", name: "project-kb", provider: "qoder" });

// Create session
console.log(`📡 Creating session with memory_store...`);
const session = (await (
	await fetch(`${BASE}/sessions`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			agent: agent.remote_id,
			environment_id: env.remote_id,
			title: "Complex integration test",
			...(memStore ? { resources: [{ type: "memory_store", memory_store_id: memStore.remote_id }] } : {}),
		}),
	})
).json()) as { id: string };

console.log(`   Session: ${session.id}`);

// Send a message that triggers tool usage
const message = `Search the web for "Bun runtime latest version 2026" and tell me what version it is. Keep your answer to one sentence.`;
console.log(`\n💬 Sending: "${message}"`);

await fetch(`${BASE}/sessions/${session.id}/events`, {
	method: "POST",
	headers,
	body: JSON.stringify({
		events: [{ type: "user.message", content: [{ type: "text", text: message }] }],
	}),
});

// Stream with timeout
console.log(`\n📥 Streaming (timeout: 90s)...\n`);

const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 90_000);

const sseRes = await fetch(`${BASE}/sessions/${session.id}/events/stream`, {
	headers: { Authorization: `Bearer ${PAT}`, Accept: "text/event-stream" },
	signal: controller.signal,
});

const reader = sseRes.body!.getReader();
const decoder = new TextDecoder();
let buffer = "";

outer: while (true) {
	const { value, done } = await reader.read();
	if (done) break;

	buffer += decoder.decode(value, { stream: true });
	const lines = buffer.split("\n");
	buffer = lines.pop()!;

	for (const line of lines) {
		if (!line.startsWith("data: ")) continue;
		try {
			const data = JSON.parse(line.slice(6));
			switch (data.type) {
				case "agent.tool_use":
					console.log(`   🔧 ${data.name}(${JSON.stringify(data.input ?? {}).slice(0, 100)}...)`);
					break;
				case "agent.tool_result": {
					const text = Array.isArray(data.content) ? (data.content[0]?.text ?? "") : String(data.content);
					console.log(`   📋 Result: ${text.slice(0, 120)}${text.length > 120 ? "..." : ""}`);
					break;
				}
				case "agent.message": {
					const msg = Array.isArray(data.content)
						? data.content.map((c: { text?: string }) => c.text ?? "").join("")
						: data.content;
					if (msg) console.log(`\n🤖 Agent: ${msg}`);
					break;
				}
				case "session.status_idle":
					if (data.usage) {
						console.log(`\n📊 Tokens: ${data.usage.input_tokens} in / ${data.usage.output_tokens} out`);
					}
					break outer;
			}
		} catch {}
	}
}

clearTimeout(timeout);
reader.releaseLock();
console.log(`\n✅ Done: ${session.id}\n`);
