// Read-only inventory: list existing agents/environments/sessions on both
// providers so the e2e can REUSE a ready agent+env (avoid create + provisioning).
import { ClaudeClient } from "../../src/internal/providers/claude/client.ts";
import { QoderClient } from "../../src/internal/providers/qoder/client.ts";

function pick(o: Record<string, unknown>, keys: string[]): string {
	return keys.map((k) => `${k}=${JSON.stringify(o[k])}`).join(" ");
}

async function dump(name: string, get: (p: string) => Promise<unknown>) {
	console.log(`\n=== ${name} ===`);
	for (const [label, path, keys] of [
		["agents", "/agents?limit=10", ["id", "name", "model", "version", "status", "archived"]],
		["environments", "/environments?limit=10", ["id", "name", "status", "archived"]],
		["sessions", "/sessions?limit=5", ["id", "status", "agent", "agent_id", "environment_id"]],
	] as const) {
		try {
			const res = (await get(path)) as { data?: Record<string, unknown>[] };
			const rows = res.data ?? [];
			console.log(`${label}: ${rows.length}`);
			for (const r of rows) console.log(`   - ${pick(r, keys as unknown as string[])}`);
		} catch (e) {
			console.log(`${label}: ERROR ${(e as Error).message.slice(0, 160)}`);
		}
	}
}

if (Bun.env.ANTHROPIC_API_KEY) {
	const c = new ClaudeClient({ apiKey: Bun.env.ANTHROPIC_API_KEY });
	await dump("CLAUDE", (p) => c.get(p));
} else console.log("CLAUDE: no key");

if (Bun.env.QODER_PAT) {
	const q = new QoderClient({ apiKey: Bun.env.QODER_PAT });
	await dump("QODER", (p) => q.get(p));
} else console.log("QODER: no key");

console.log("\nDone.");
