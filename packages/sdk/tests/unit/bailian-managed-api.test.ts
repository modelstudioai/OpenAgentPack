import { afterEach, describe, expect, mock, test } from "bun:test";
import {
	downloadRemoteSkill,
	getManagedAgentProviderCapabilities,
} from "../../src/internal/core/managed-api-runtime.ts";
import type { ProjectRuntimeContext } from "../../src/internal/core/project-runtime.ts";
import { sanitizeSessionEvent } from "../../src/internal/core/session-event-sanitizer.ts";
import { BailianAdapter } from "../../src/internal/providers/bailian/adapter.ts";
import { toSessionEvent } from "../../src/internal/providers/bailian/event-mapper.ts";

const BASE = "https://bailian.test/api/v1/agentstudio";
const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function adapter(): BailianAdapter {
	return new BailianAdapter("sk-test", "ws-test", BASE, "managed-api-test");
}

function installJsonFetch(responses: unknown[]) {
	const calls: Array<{ url: string; method: string; body?: unknown }> = [];
	let responseIndex = 0;
	globalThis.fetch = mock(async (input: string | URL, init?: RequestInit) => {
		const call: { url: string; method: string; body?: unknown } = {
			url: String(input),
			method: init?.method ?? "GET",
		};
		if (typeof init?.body === "string") call.body = JSON.parse(init.body);
		calls.push(call);
		return new Response(JSON.stringify(responses[responseIndex++] ?? {}), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}) as unknown as typeof fetch;
	return calls;
}

describe("Bailian managed API reads", () => {
	test("preserves agent cursors and version parameters", async () => {
		const calls = installJsonFetch([
			{ data: [{ id: "agent_1", name: "one" }], next_page: "P2" },
			{ id: "agent_1", name: "one", version: 2 },
			{ data: [{ id: "agent_1", name: "one", version: 2 }], next_page: null },
		]);

		const page = await adapter().listAgentResources({ limit: 10, page: "P1", include_archived: true });
		const detail = await adapter().getRemoteAgent("agent_1", 2);
		const versions = await adapter().listAgentVersions("agent_1", { limit: 5 });

		expect(new URL(calls[0]!.url).searchParams.get("page")).toBe("P1");
		expect(new URL(calls[0]!.url).searchParams.get("include_archived")).toBe("true");
		expect(calls[1]!.url).toBe(`${BASE}/agents/agent_1?version=2`);
		expect(calls[2]!.url).toBe(`${BASE}/agents/agent_1/versions?limit=5`);
		expect(page.next_page).toBe("P2");
		expect(detail.version).toBe(2);
		expect(versions.has_more).toBe(false);
	});

	test("maps skill, vault, environment, and file list parameters", async () => {
		const calls = installJsonFetch([
			{ data: [], next_page: null },
			{ data: [], next_page: "V2" },
			{ data: [], next_page: null },
			{ data: [], next_page: null },
		]);

		await adapter().listSkillResources({ source: "custom", limit: 20, page: "S1" });
		await adapter().listVaultResources({ include_archived: true, limit: 3 });
		await adapter().listEnvironmentResources({ include_archived: false, page: "E1" });
		await adapter().listFileResources({ scope_id: "sesn_1", limit: 50, page: "F1" });

		expect(new URL(calls[0]!.url).searchParams.get("source")).toBe("customer");
		expect(new URL(calls[1]!.url).searchParams.get("include_archived")).toBe("true");
		expect(new URL(calls[2]!.url).searchParams.get("include_archived")).toBe("false");
		expect(new URL(calls[3]!.url).searchParams.get("scope_id")).toBe("sesn_1");
	});

	test("supports skill versions and download metadata", async () => {
		const calls = installJsonFetch([
			{
				data: [{ id: "skillver_1", skill_id: "skill_1", version: "1.0", type: "skill_version" }],
				next_page: "SV2",
			},
			{ skill_id: "skill_1", version: "1.0", type: "skill_version" },
			{ skill_id: "skill_1", version: "1.0", file_url: "https://download.test/skill.zip" },
		]);

		const versions = await adapter().listSkillVersions("skill_1", { limit: 100, page: "SV1" });
		const version = await adapter().getSkillVersion("skill_1", "1.0");
		const download = await adapter().getSkillDownloadInfo("skill_1", "1.0");

		expect(calls[0]!.url).toBe(`${BASE}/skills/skill_1/versions?limit=100&page=SV1`);
		expect(versions.data[0]?.id).toBe("skillver_1");
		expect(versions.has_more).toBe(true);
		expect(versions.next_page).toBe("SV2");
		expect(version.version).toBe("1.0");
		expect(download.file_url).toBe("https://download.test/skill.zip");
	});

	test("forwards deployment keyword and exposes run history", async () => {
		const calls = installJsonFetch([
			{ data: [{ id: "depl_1", status: "active" }], next_page: "D2" },
			{ data: [{ id: "run_1", deployment_id: "depl_1", status: "completed" }], next_page: null },
			{ id: "run_1", deployment_id: "depl_1", status: "completed" },
		]);

		const deployments = await adapter().listDeployments({ keyword: "report", limit: 20, page: "D1" });
		const runs = await adapter().listDeploymentRuns("depl_1", { limit: 10, page: "R1" });
		const run = await adapter().getDeploymentRun("run_1");

		expect(new URL(calls[0]!.url).searchParams.get("keyword")).toBe("report");
		expect(calls[1]!.url).toBe(`${BASE}/deployments/depl_1/runs?limit=10&page=R1`);
		expect(calls[2]!.url).toBe(`${BASE}/deployment_runs/run_1`);
		expect(deployments.has_more).toBe(true);
		expect(runs.data[0]?.id).toBe("run_1");
		expect(run.status).toBe("completed");
	});

	test("uses direct deployment action and file-content endpoints", async () => {
		const calls = installJsonFetch([
			{ id: "run_1", session_id: "sesn_1" },
			{ id: "depl_1", status: "paused" },
			{ id: "depl_1", status: "active" },
			{ content: "file bytes" },
		]);

		const run = await adapter().runDeploymentById("depl_1");
		await adapter().pauseDeploymentById("depl_1");
		await adapter().unpauseDeploymentById("depl_1");
		const file = await adapter().downloadFileContent("file_1");

		expect(calls.map((call) => [call.method, call.url])).toEqual([
			["POST", `${BASE}/deployments/depl_1/run`],
			["POST", `${BASE}/deployments/depl_1/pause`],
			["POST", `${BASE}/deployments/depl_1/unpause`],
			["GET", `${BASE}/files/file_1/content`],
		]);
		expect(run.session_id).toBe("sesn_1");
		expect(file.byteLength).toBeGreaterThan(0);
	});

	test("downloads a skill from provider-issued content metadata", async () => {
		const runtime = {
			providers: new Map([
				[
					"bailian",
					{
						name: "bailian",
						getSkillDownloadInfo: async () => ({
							skill_id: "skill_1",
							version: "1",
							file_url: "https://download.test/skill.zip",
						}),
					},
				],
			]),
		} as unknown as ProjectRuntimeContext;
		globalThis.fetch = mock(async (input: string | URL) => {
			expect(String(input)).toBe("https://download.test/skill.zip");
			return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
		}) as unknown as typeof fetch;

		const bytes = await downloadRemoteSkill(runtime, "skill_1", "1", { provider: "bailian" });
		expect(Array.from(bytes)).toEqual([1, 2, 3]);
	});
});

describe("Bailian session API additions", () => {
	test("forwards filters, updates, archives, and sends raw events", async () => {
		const session = {
			id: "sesn_1",
			status: "idle",
			agent: { id: "agent_1" },
			environment_id: "env_1",
			created_at: "2026-01-01T00:00:00Z",
			updated_at: "2026-01-01T00:00:00Z",
		};
		const calls = installJsonFetch([
			{ data: [session], next_page: null },
			{ id: "sesn_1", status: "idle", title: "updated" },
			{ ...session, title: "updated" },
			{ ...session, status: "terminated" },
			{ data: [{ id: "event_1" }] },
			{ data: [{ id: "event_2", type: "message", content: [] }], next_page: null },
		]);

		await adapter().listSessions({
			agent_id: "agent_1",
			statuses: ["idle", "running"],
			created_at_gte: "2026-01-01T00:00:00Z",
			limit: 20,
		});
		await adapter().updateSession("sesn_1", { title: "updated" });
		await adapter().archiveSession("sesn_1");
		const sent = await adapter().sendSessionEvents("sesn_1", [
			{ role: "user", type: "interrupt", session_thread_id: "sthr_1" },
		]);
		const listed = await adapter().listSessionEvents("sesn_1", {
			types: ["message"],
			order: "asc",
			limit: 20,
		});

		const listUrl = new URL(calls[0]!.url);
		expect(listUrl.searchParams.getAll("statuses[]")).toEqual(["idle", "running"]);
		expect(listUrl.searchParams.get("created_at[gte]")).toBe("2026-01-01T00:00:00Z");
		expect(calls[1]!.body).toEqual({ title: "updated" });
		expect(calls[2]!.url).toBe(`${BASE}/sessions/sesn_1`);
		expect(calls[3]!.url).toBe(`${BASE}/sessions/sesn_1/archive`);
		expect(calls[4]!.body).toEqual({
			input: [{ role: "user", type: "interrupt", session_thread_id: "sthr_1" }],
		});
		const eventListUrl = new URL(calls[5]!.url);
		expect(eventListUrl.searchParams.get("order")).toBe("asc");
		expect(eventListUrl.searchParams.has("types")).toBe(false);
		expect(sent.event_ids).toEqual(["event_1"]);
		expect(listed.events[0]?.id).toBe("event_2");
	});

	test("preserves child-thread id through mapping and sanitization", () => {
		const mapped = toSessionEvent({
			type: "thread_created",
			content: [{ type: "data", data: { session_thread_id: "sthr_1", agent_name: "researcher" } }],
		});
		const sanitized = sanitizeSessionEvent(mapped);
		expect(mapped.session_thread_id).toBe("sthr_1");
		expect(sanitized.metadata?.session_thread_id).toBe("sthr_1");
	});
});

test("operation capabilities distinguish Managed Agents Thread from deprecated Assistant Thread", () => {
	const capabilities = getManagedAgentProviderCapabilities("bailian");
	expect(capabilities.operations["agent.create"]?.supported).toBe(true);
	expect(capabilities.operations["environment.create"]?.supported).toBe(true);
	expect(capabilities.operations["skill.create"]?.supported).toBe(true);
	expect(capabilities.operations["vault.create"]?.supported).toBe(true);
	expect(capabilities.operations["vault.credential.create"]?.supported).toBe(true);
	expect(capabilities.operations["deployment.create"]?.supported).toBe(true);
	expect(capabilities.operations["session.event.list"]?.supported).toBe(true);
	expect(capabilities.operations["session_thread.list"]?.supported).toBe(false);
	expect(capabilities.operations["model.list"]?.supported).toBe(false);
});
