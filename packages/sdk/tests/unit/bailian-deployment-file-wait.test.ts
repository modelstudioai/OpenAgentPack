import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BailianAdapter } from "../../src/internal/providers/bailian/adapter.ts";
import type { DeploymentContext } from "../../src/internal/providers/interface.ts";

// A freshly uploaded file lands in `checking`; binding it to a session (bindSessionFiles)
// rejects an unavailable source with "源文件不可用". The emulated deployment run must poll the
// Files API to `available` before POST /sessions, just like the skill-upload path. This locks
// in that ordering so the bind never races the content audit again.

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("BailianAdapter emulated deployment file upload", () => {
	test("waits for the uploaded file to become available before creating the session", async () => {
		const dir = mkdtempSync(join(tmpdir(), "agents-dep-"));
		writeFileSync(join(dir, "report-template.md"), "# template");

		const calls: string[] = [];
		let fileStatus = "checking";

		globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = new URL(String(input));
			const path = url.pathname;
			const method = init?.method ?? "GET";
			calls.push(`${method} ${path}`);

			if (method === "POST" && path.endsWith("/files")) {
				return Response.json({ id: "file_x", filename: "report-template.md", status: "checking" });
			}
			if (method === "GET" && path.endsWith("/files/file_x")) {
				// Flip to available on the first poll so the wait is short but real.
				const status = fileStatus;
				fileStatus = "available";
				return Response.json({ id: "file_x", filename: "report-template.md", status });
			}
			if (method === "POST" && path.endsWith("/sessions")) {
				return Response.json({ id: "sesn_1" });
			}
			if (method === "POST" && path.endsWith("/sessions/sesn_1/events")) {
				return Response.json({ id: "evt_1" });
			}
			throw new Error(`unexpected ${method} ${path}`);
		}) as typeof fetch;

		const adapter = new BailianAdapter("sk-test", "ws-test", "https://bailian.test/api/v1/agentstudio");
		const ctx: DeploymentContext = {
			id: null,
			name: "daily-report",
			decl: {
				agent: "reporter",
				initial_events: [{ type: "user.message", content: "go" }],
				resources: [{ type: "file", source: "report-template.md", mount_path: "/data/report-template.md" }],
			},
			refs: { agent_id: "agent_1", environment_id: "env_1", vault_ids: [], memory_store_ids: {} },
			basePath: join(dir, "agents.yaml"),
		};

		const res = await adapter.runDeployment(ctx);
		expect(res.session_id).toBe("sesn_1");

		const pollIdx = calls.indexOf("GET /api/v1/agentstudio/files/file_x");
		const sessionIdx = calls.indexOf("POST /api/v1/agentstudio/sessions");
		expect(pollIdx).toBeGreaterThanOrEqual(0);
		expect(sessionIdx).toBeGreaterThanOrEqual(0);
		expect(pollIdx).toBeLessThan(sessionIdx);
	});
});
