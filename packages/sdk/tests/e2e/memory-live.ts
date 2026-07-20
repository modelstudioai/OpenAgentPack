#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { ArkAdapter } from "../../src/internal/providers/ark/adapter.ts";
import { ClaudeAdapter } from "../../src/internal/providers/claude/adapter.ts";
import type { ProviderAdapter } from "../../src/internal/providers/interface.ts";
import { QoderAdapter } from "../../src/internal/providers/qoder/adapter.ts";

const provider = process.argv[2];
let adapter: ProviderAdapter;
if (provider === "qoder" && process.env.QODER_PAT) adapter = new QoderAdapter(process.env.QODER_PAT);
else if (provider === "claude" && process.env.ANTHROPIC_API_KEY)
	adapter = new ClaudeAdapter(process.env.ANTHROPIC_API_KEY);
else if (provider === "ark" && process.env.ARK_API_KEY) adapter = new ArkAdapter(process.env.ARK_API_KEY);
else throw new Error("Usage: bun memory-live.ts <qoder|claude|ark> with the provider API key set");

const required = [
	"createMemoryStore",
	"deleteMemoryStore",
	"createMemory",
	"listMemories",
	"getMemory",
	"updateMemory",
	"deleteMemory",
] as const;
for (const name of required) if (typeof adapter[name] !== "function") throw new Error(`${provider}.${name} is missing`);

const suffix = Date.now().toString(36);
const store = await adapter.createMemoryStore!(`openagentpack-memory-live-${suffix}`, {
	description: "Temporary OpenAgentPack memory lifecycle probe",
	metadata: { test: "memory-live" },
});
if (!store.id) throw new Error("provider returned no memory store id");

try {
	const created = await adapter.createMemory!(store.id, { path: `probe/${suffix}.md`, content: "version one" });
	const listed = await adapter.listMemories!(store.id, { limit: 100 });
	if (!listed.data.some((item) => item.type === "memory" && item.id === created.id))
		throw new Error("created memory absent from list");
	const read = await adapter.getMemory!(store.id, created.id);
	if (read.content !== "version one") throw new Error("retrieved content mismatch");
	const expected = createHash("sha256").update("version one").digest("hex");
	const updated = await adapter.updateMemory!(store.id, created.id, {
		content: "version two",
		expected_content_sha256: expected,
	});
	const reread = await adapter.getMemory!(store.id, created.id);
	if (reread.content !== "version two") throw new Error("updated content mismatch");

	if (adapter.memoryCapabilities?.versions) {
		const versions = await adapter.listMemoryVersions!(store.id, { memory_id: created.id, view: "full" });
		if (versions.data.length < 2) throw new Error("expected at least two memory versions");
	}
	if (adapter.memoryCapabilities?.batch_create) {
		const batch = await adapter.batchCreateMemories!(store.id, {
			items: [{ path: `probe/${suffix}-batch.md`, content: "batch" }],
			on_conflict: "fail",
		});
		if (!batch.results[0]?.memory) throw new Error(`batch create failed: ${JSON.stringify(batch.results[0])}`);
	}

	await adapter.deleteMemory!(store.id, created.id, updated.content_sha256);
	console.log(JSON.stringify({ provider, store_id: store.id, result: "passed" }));
} finally {
	await adapter.deleteMemoryStore!(store.id);
}
