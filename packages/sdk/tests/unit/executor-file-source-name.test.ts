import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { executePlan } from "../../src/internal/executor/executor.ts";
import { BailianAdapter } from "../../src/internal/providers/bailian/adapter.ts";
import { StateManager } from "../../src/internal/state/state-manager.ts";
import { setDefaultFetch } from "../../src/internal/transport.ts";
import type { ProjectConfig } from "../../src/internal/types/config.ts";
import type { ExecutionPlan } from "../../src/internal/types/plan.ts";
import type { ResourceAddress } from "../../src/internal/types/state.ts";

let fixtureRoot: string;
let uploadedFiles: Array<{ filename: string; mimeType: string; content: string }>;
let requests: string[];

beforeEach(async () => {
	fixtureRoot = await mkdtemp(join(tmpdir(), "executor-file-source-name-"));
	uploadedFiles = [];
	requests = [];
	setDefaultFetch(async (input, options) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		const method = options?.method ?? "GET";
		requests.push(`${method} ${url.pathname}`);
		if (method === "POST" && url.pathname === "/files" && options?.body instanceof FormData) {
			const uploaded = options.body.get("file");
			if (!(uploaded instanceof File)) throw new Error("Expected a multipart file");
			uploadedFiles.push({
				filename: uploaded.name,
				mimeType: uploaded.type.split(";")[0]!,
				content: await uploaded.text(),
			});
			return Response.json({ id: "file_new", filename: uploaded.name, status: "available" });
		}
		if (method === "DELETE" && url.pathname === "/files/file_old") {
			return new Response(null, { status: 204 });
		}
		throw new Error(`Unexpected request: ${method} ${url.pathname}`);
	});
});

afterEach(async () => {
	setDefaultFetch(undefined);
	await rm(fixtureRoot, { recursive: true, force: true });
});

describe("declarative File upload filenames", () => {
	for (const action of ["create", "update"] as const) {
		for (const scenario of [
			{
				label: "extensionless label",
				name: "Assistant Reference",
				filename: "reference.md",
				mimeType: "text/markdown",
			},
			{ label: "different extension", name: "notes.pdf", filename: "project-notes.md", mimeType: "text/markdown" },
			{
				label: "absolute Unicode source",
				name: "Reference",
				filename: "参考 资料.MD",
				mimeType: "text/markdown",
				absoluteSource: true,
			},
			{ label: "omitted name", name: undefined, filename: "report.txt", mimeType: "text/plain" },
		]) {
			test(`${action} uses the source basename with ${scenario.label}`, async () => {
				const sourcePath = join(fixtureRoot, "agents/assistant/files/reference", scenario.filename);
				const configPath = join(fixtureRoot, ".openagentpack/build/agents.yaml");
				const content = "# Original source content\n";
				await mkdir(dirname(sourcePath), { recursive: true });
				await mkdir(dirname(configPath), { recursive: true });
				await writeFile(sourcePath, content);
				const config: ProjectConfig = {
					version: "1",
					providers: { bailian: { api_key: "mock-only", base_url: "https://example.invalid" } },
					defaults: { provider: "bailian" },
					files: {
						reference: {
							source: scenario.absoluteSource ? sourcePath : relative(dirname(configPath), sourcePath),
							name: scenario.name,
						},
					},
				};
				const address: ResourceAddress = { type: "file", name: "reference", provider: "bailian" };
				const state = StateManager.initialize(join(fixtureRoot, ".openagentpack/state.json"));
				if (action === "update") state.setResource({ address, remote_id: "file_old", content_hash: "old" });
				const plan: ExecutionPlan = {
					actions: [{ action, address, reason: "Test source filename", dependencies: [] }],
					diagnostics: [],
				};
				const result = await executePlan(plan, {
					config,
					configPath,
					state,
					providers: new Map([["bailian", new BailianAdapter("mock-only", undefined, "https://example.invalid")]]),
				});

				expect(result.partial).toBe(false);
				expect(result.results[0]?.status).toBe("success");
				expect(uploadedFiles).toEqual([{ filename: scenario.filename, mimeType: scenario.mimeType, content }]);
				expect(requests).toEqual(action === "update" ? ["DELETE /files/file_old", "POST /files"] : ["POST /files"]);
				expect(state.getResource(address)?.remote_id).toBe("file_new");
				expect(config.files?.reference?.name).toBe(scenario.name);
			});
		}
	}

	test("direct uploads still honor an explicit filename override", async () => {
		const sourcePath = join(fixtureRoot, "original.md");
		await writeFile(sourcePath, "Original content");
		const adapter = new BailianAdapter("mock-only", undefined, "https://example.invalid");
		await adapter.uploadFile(sourcePath, { name: "renamed.txt" });
		expect(uploadedFiles).toEqual([{ filename: "renamed.txt", mimeType: "text/plain", content: "Original content" }]);
	});
});
