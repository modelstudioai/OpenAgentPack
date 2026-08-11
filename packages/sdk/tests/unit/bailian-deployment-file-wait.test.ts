import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BailianAdapter } from "../../src/internal/providers/bailian/adapter.ts";
import type { ResolvedDeploymentRefs } from "../../src/internal/providers/interface.ts";
import type { DeploymentDecl } from "../../src/internal/types/config.ts";

// A freshly uploaded file lands in `checking`; attaching it to a deployment before the
// content audit finishes is rejected downstream. createDeployment must poll the Files API
// to `available` before POST /deployments, just like the skill-upload path. This locks in
// that ordering so the deployment never references a file the audit hasn't cleared.

const originalFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("BailianAdapter deployment file upload", () => {
	test("waits for the uploaded file to become available before creating the deployment", async () => {
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
			if (method === "POST" && path.endsWith("/deployments")) {
				return Response.json({ id: "depl_1", type: "deployment" });
			}
			throw new Error(`unexpected ${method} ${path}`);
		}) as typeof fetch;

		const adapter = new BailianAdapter("sk-test", "ws-test", "https://bailian.test/api/v1/agentstudio");
		const decl: DeploymentDecl = {
			agent: "reporter",
			initial_events: [{ type: "user.message", content: "go" }],
			resources: [{ type: "file", source: "report-template.md", mount_path: "/mnt/report-template.md" }],
		};
		const refs: ResolvedDeploymentRefs = {
			agent_id: "agent_1",
			environment_id: "env_1",
			vault_ids: [],
			memory_store_ids: {},
		};

		const res = await adapter.createDeployment("daily-report", decl, refs, join(dir, "agents.yaml"));
		expect(res.id).toBe("depl_1");

		const pollIdx = calls.indexOf("GET /api/v1/agentstudio/files/file_x");
		const deployIdx = calls.indexOf("POST /api/v1/agentstudio/deployments");
		expect(pollIdx).toBeGreaterThanOrEqual(0);
		expect(deployIdx).toBeGreaterThanOrEqual(0);
		expect(pollIdx).toBeLessThan(deployIdx);
	});
});
