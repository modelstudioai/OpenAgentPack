import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@openagentpack/sdk";
import { buildRunTimeline, buildToolChainRows } from "../src/lib/view/run-timeline";
import { classifySessionPreviewLoadError } from "../src/session-preview/errors";
import { mergeSessionEvents, sessionEventKey } from "../src/session-preview/events";
import { agentSessionPreviewIdFromPath, sessionPreviewIdFromPath } from "../src/session-preview/route";
import { buildPreviewArtifacts, buildPreviewCapabilities } from "../src/session-preview/sidebar-data";

function message(eventId: string, role: "user" | "assistant", text: string): SessionEvent {
	return {
		event_id: eventId,
		type: "message",
		role,
		content: [{ type: "text", text }],
		metadata: { display_bucket: "message" },
	};
}

describe("Session Preview routing", () => {
	test("restores one Session from a deep link", () => {
		expect(sessionPreviewIdFromPath("/sessions/session-123/preview")).toBe("session-123");
		expect(sessionPreviewIdFromPath("/sessions/session%3A123/preview/")).toBe("session:123");
	});

	test("opens an Agent Preview before any initial message exists", () => {
		expect(agentSessionPreviewIdFromPath("/agents/assistant/preview")).toBe("assistant");
		expect(agentSessionPreviewIdFromPath("/agents/team%3Aassistant/preview/")).toBe("team:assistant");
		expect(agentSessionPreviewIdFromPath("/sessions/session-123/preview")).toBeNull();
	});

	test("distinguishes workbench paths from malformed preview links", () => {
		expect(sessionPreviewIdFromPath("/")).toBeNull();
		expect(sessionPreviewIdFromPath("/sessions//preview")).toBe("");
		expect(sessionPreviewIdFromPath("/sessions/a%2Fb/preview")).toBe("");
		expect(sessionPreviewIdFromPath("/sessions/%E0%A4%A/preview")).toBe("");
	});
});

describe("Session Preview event recovery", () => {
	test("de-duplicates history replay and live SSE events by event ID", () => {
		const first = message("event-1", "user", "Hello");
		const duplicate = message("event-1", "user", "A replayed copy");
		const reply = message("event-2", "assistant", "Hi");

		expect(sessionEventKey(first)).toBe("id:event-1");
		expect(mergeSessionEvents([first], [duplicate, reply])).toEqual([first, reply]);
	});

	test("uses a deterministic fallback when a Provider omits event IDs", () => {
		const first = { ...message("event-1", "assistant", "same"), event_id: undefined };
		const duplicate = { ...first };
		expect(mergeSessionEvents([first], [duplicate])).toEqual([first]);
	});
});

describe("Session Preview recovery errors", () => {
	test("distinguishes unknown project Sessions from terminated Provider Sessions", () => {
		expect(classifySessionPreviewLoadError(Object.assign(new Error("missing"), { status: 404 })).reason).toBe(
			"not_found",
		);
		expect(classifySessionPreviewLoadError(new Error('Bailian API 404: {"message":"Session not found"}')).reason).toBe(
			"unrecoverable",
		);
	});

	test("recognizes a stopped local Server", () => {
		expect(classifySessionPreviewLoadError(new TypeError("Failed to fetch")).reason).toBe("server_unavailable");
	});
});

describe("Session Preview timeline", () => {
	test("shows the leading user message while preserving the legacy modal default", () => {
		const user = message("event-1", "user", "Start the task");
		const agent = message("event-2", "assistant", "Done");

		expect(buildRunTimeline([user, agent]).map((item) => item.key)).toEqual(["event-2"]);
		expect(buildRunTimeline([user, agent], { includeLeadingUser: true }).map((item) => item.key)).toEqual([
			"event-1",
			"event-2",
		]);
	});

	test("shows agent-playground tool input and output in one expandable action", () => {
		const rows = buildToolChainRows([
			{
				event_id: "tool-call",
				type: "tool_call",
				content: [{ type: "data", data: { name: "Write", arguments: '{"path":"index.html"}' } }],
			},
			{
				event_id: "tool-result",
				type: "tool_call_output",
				content: [{ type: "data", data: { name: "Write", output: '{"bytes":128}' } }],
			},
		]);

		expect(rows).toHaveLength(1);
		expect(rows[0]?.input).toBe('{\n  "path": "index.html"\n}');
		expect(rows[0]?.output).toBe('{\n  "bytes": 128\n}');
	});

	test("summarizes pinned tools, skills and MCPs with actual invocation counts", () => {
		const timeline = buildRunTimeline(
			[
				{
					event_id: "tool-call",
					type: "tool_call",
					content: [{ type: "data", data: { name: "WebSearch", arguments: '{"query":"agents"}' } }],
				},
				{
					event_id: "skill-call",
					type: "tool_call",
					content: [{ type: "data", data: { name: "Skill", arguments: '{"skill":"bailian-cli"}' } }],
				},
			],
			{ includeLeadingUser: true },
		);
		const capabilities = buildPreviewCapabilities(
			{
				id: "assistant",
				agentName: "Assistant",
				provider: "bailian",
				tools: { builtin: ["WebSearch"] },
				skills: [{ type: "custom", id: "bailian-cli" }],
				mcpServers: ["docs"],
			},
			timeline,
		);

		expect(capabilities).toEqual([
			expect.objectContaining({ kind: "tool", name: "Skill", count: 1, configured: false }),
			expect.objectContaining({ kind: "tool", name: "WebSearch", count: 1, configured: true }),
			expect.objectContaining({ kind: "skill", name: "bailian-cli", count: 1, configured: true }),
			expect.objectContaining({ kind: "mcp", name: "docs", count: 0, configured: true }),
		]);
	});

	test("collects message URLs and delivered files for the Session side panel", () => {
		const timeline = buildRunTimeline(
			[
				message("event-1", "assistant", "[报告](https://example.com/report.pdf)"),
				{
					event_id: "event-2",
					type: "tool_call_output",
					metadata: {
						display_bucket: "tool_result",
						artifact: { file_id: "file-1", filename: "result.csv" },
					},
				},
			],
			{ includeLeadingUser: true },
		);

		expect(buildPreviewArtifacts(timeline)).toEqual([
			expect.objectContaining({ kind: "file", title: "报告", url: "https://example.com/report.pdf" }),
			expect.objectContaining({ kind: "delivered_file", title: "result.csv", fileId: "file-1" }),
		]);
	});
});

const appSource = await Bun.file(new URL("../src/App.tsx", import.meta.url)).text();
const launcherSource = await Bun.file(
	new URL("../src/session-preview/AgentSessionPreviewLauncher.tsx", import.meta.url),
).text();
const previewSource = await Bun.file(new URL("../src/session-preview/SessionPreviewPage.tsx", import.meta.url)).text();
const previewHookSource = await Bun.file(
	new URL("../src/session-preview/useProjectSessionPreview.ts", import.meta.url),
).text();
const previewStyleSource = await Bun.file(new URL("../src/app/session-preview.css", import.meta.url)).text();

test("Preview entry lives in the Agent title area and does not revive legacy task control", () => {
	const previewEntryIndex = appSource.indexOf("agent-preview-link");
	const debugPanelIndex = appSource.indexOf("function DebugPanel");
	expect(previewEntryIndex).toBeGreaterThan(-1);
	expect(previewEntryIndex).toBeLessThan(debugPanelIndex);
	expect(appSource.slice(debugPanelIndex)).not.toContain("agent-preview-link");
	expect(launcherSource).toContain("startSession(agentId)");
	expect(launcherSource).toContain("window.history.replaceState");
	expect(appSource).not.toContain("Session Preview");
	expect(previewSource).toContain("session-preview-eyebrow");
	expect(previewSource).toContain('preview.detail?.agent_name ?? "Loading Agent…"');
	expect(previewSource).toContain("session-preview-composer-shell");
	expect(previewSource).toContain("SessionPreviewSidePanel");
	expect(previewStyleSource).toContain("session-preview-side-panel");
	expect(previewSource).not.toContain("ModelSelector");
	expect(previewSource).not.toContain("useModelSelection");
	expect(previewStyleSource).toContain("agent-playground Task Page parity");
	expect(previewStyleSource).toContain("var(--colorPrimaryBg, #f0f7ff)");
	expect(previewHookSource).not.toContain("useTaskRunStream");
	expect(previewHookSource).not.toContain("useRunFollowup");
	expect(previewHookSource).not.toContain("task-client-store");
	expect(previewHookSource).not.toContain("playbook");
});
