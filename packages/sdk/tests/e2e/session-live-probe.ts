// Non-mutating live probe: verifies the request-body shape that each provider's
// `mapSendMessage` produces is actually accepted by POST /sessions/{id}/events.
// Strategy: POST to a BOGUS session id. If the body shape is wrong we expect a
// 400 schema error; if the body shape is right we expect a 404 (session missing).
// Comparing the two payloads against the same bogus id isolates "body shape" as
// the only variable. No resources are created.

import { ApiError } from "../../src/internal/providers/base-client.ts";
import { ClaudeClient } from "../../src/internal/providers/claude/client.ts";
import { mapSendMessage as claudeSend } from "../../src/internal/providers/claude/mapper.ts";
import { QoderClient } from "../../src/internal/providers/qoder/client.ts";
import { mapSendMessage as qoderSend } from "../../src/internal/providers/qoder/mapper.ts";

const BOGUS = "sess_0000000000000000000000";

function show(label: string, err: unknown) {
	if (err instanceof ApiError) {
		const body = err.responseBody.slice(0, 400).replace(/\s+/g, " ");
		console.log(`   ${label}: HTTP ${err.statusCode} — ${body}`);
	} else if (err instanceof Error) {
		console.log(`   ${label}: threw ${err.message.slice(0, 200)}`);
	} else {
		console.log(`   ${label}: <no error> (unexpected 2xx)`);
	}
}

async function postExpectError(fn: () => Promise<unknown>): Promise<unknown> {
	try {
		const ok = await fn();
		return { ok };
	} catch (e) {
		return e;
	}
}

async function probeClaude() {
	const key = Bun.env.ANTHROPIC_API_KEY;
	console.log("\n=== CLAUDE ===");
	if (!key) {
		console.log("   ⏭  ANTHROPIC_API_KEY not loaded — skipping");
		return;
	}
	const client = new ClaudeClient({ apiKey: key });

	// Preflight: confirm auth + managed-agents beta access.
	try {
		const res = (await client.get("/sessions?limit=1")) as { data?: unknown[] };
		console.log(`   preflight GET /sessions?limit=1: OK (data len=${res.data?.length ?? 0})`);
	} catch (e) {
		show("preflight GET /sessions", e);
		console.log("   ⚠  preflight failed — probe results below may reflect auth/beta, not body shape");
	}

	// (a) EXACTLY what the current code sends (bare array).
	const codePayload = claudeSend("hello from probe");
	console.log(`   code payload (mapSendMessage) = ${JSON.stringify(codePayload)}`);
	show("(a) code bare-array body", await postExpectError(() => client.post(`/sessions/${BOGUS}/events`, codePayload)));

	// (b) Doc-correct wrapped body.
	const wrapped = { events: [{ type: "user.message", content: [{ type: "text", text: "hello from probe" }] }] };
	show(
		"(b) wrapped {events:[...]} body",
		await postExpectError(() => client.post(`/sessions/${BOGUS}/events`, wrapped)),
	);
}

async function probeQoder() {
	const key = Bun.env.QODER_PAT;
	console.log("\n=== QODER ===");
	if (!key) {
		console.log("   ⏭  QODER_PAT not loaded — skipping");
		return;
	}
	const client = new QoderClient({ apiKey: key });

	try {
		const res = (await client.get("/sessions?limit=1")) as { data?: unknown[] };
		console.log(`   preflight GET /sessions?limit=1: OK (data len=${res.data?.length ?? 0})`);
	} catch (e) {
		show("preflight GET /sessions", e);
		console.log("   ⚠  preflight failed — probe results below may reflect auth, not body shape");
	}

	// (a) EXACTLY what the current code sends (wrapped {events:[...]}).
	const codePayload = qoderSend("hello from probe");
	console.log(`   code payload (mapSendMessage) = ${JSON.stringify(codePayload)}`);
	show("(a) code wrapped body", await postExpectError(() => client.post(`/sessions/${BOGUS}/events`, codePayload)));

	// (b) Bare object — docs say this MUST 400.
	const bare = { type: "user.message", content: "hello from probe" };
	show("(b) bare object body", await postExpectError(() => client.post(`/sessions/${BOGUS}/events`, bare)));
}

console.log("Session send-body live probe (non-mutating: bogus session id, no resources created)");
await probeClaude();
await probeQoder();
console.log("\nDone.");
