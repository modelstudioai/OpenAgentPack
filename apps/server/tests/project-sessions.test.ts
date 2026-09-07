import { describe, expect, test } from "bun:test";
import type { BackendRuntimeInput, ProviderSessionEvent } from "@openagentpack/sdk";
import { CreateProjectSessionBodySchema } from "../src/schemas/project";
import {
	assertAttachmentCompatible,
	sessionAgentDefinition,
	sessionOwnsArtifact,
} from "../src/services/project-sessions";

describe("project Session artifacts", () => {
	test("only exposes files delivered by the selected Session", () => {
		const events: ProviderSessionEvent[] = [
			{
				id: "event-1",
				type: "tool_call_output",
				raw_type: "tool_call_output",
				artifact: { file_id: "file-owned", filename: "report.pdf" },
				raw: {},
			},
		];

		expect(sessionOwnsArtifact(events, "file-owned")).toBe(true);
		expect(sessionOwnsArtifact(events, "file-other")).toBe(false);
	});

	test("ignores malformed artifact metadata", () => {
		const events: ProviderSessionEvent[] = [
			{ id: "event-1", type: "tool_call_output", raw_type: "tool_call_output", raw: {} },
			{ id: "event-2", type: "tool_call_output", raw_type: "tool_call_output", raw: {} },
		];

		expect(sessionOwnsArtifact(events, "file-owned")).toBe(false);
	});
});

describe("project Session creation", () => {
	test("accepts a Session with no initial message", () => {
		expect(CreateProjectSessionBodySchema.parse({})).toEqual({});
		expect(CreateProjectSessionBodySchema.parse({ prompt: "First message" })).toEqual({ prompt: "First message" });
	});

	test("rejects an attachment uploaded through the Agent's previous Provider", () => {
		expect(() =>
			assertAttachmentCompatible(
				{
					id: "attachment-1",
					agent_id: "assistant",
					provider: "bailian",
					remote_file_id: "file-1",
					filename: "context.txt",
					available: true,
					created_at: new Date().toISOString(),
				},
				"assistant",
				"qoder",
			),
		).toThrow(/uploaded through Provider 'bailian'.*'qoder'/);
	});

	test("returns a safe Agent capability snapshot from the pinned runtime", () => {
		const runtime = {
			config: {
				agents: {
					assistant: {
						name: "Assistant",
						description: "Pinned description",
						instructions: "Help the user",
						model: { bailian: { id: "qwen3-max", speed: "fast" } },
						tools: { builtin: ["WebSearch"] },
						skills: ["bailian-cli", { type: "official", skill_id: "web-reader", version: "1" }],
						mcp_servers: [{ name: "docs", url: "https://example.invalid/mcp" }],
					},
				},
			},
		} as unknown as BackendRuntimeInput;

		expect(sessionAgentDefinition(runtime, "assistant", "bailian")).toEqual({
			id: "assistant",
			agentName: "Assistant",
			provider: "bailian",
			description: "Pinned description",
			model: { id: "qwen3-max", speed: "fast" },
			environment: undefined,
			tools: { builtin: ["WebSearch"] },
			skills: [
				{ type: "custom", id: "bailian-cli" },
				{ type: "official", id: "web-reader", version: "1" },
			],
			mcpServers: ["docs"],
		});
	});
});
