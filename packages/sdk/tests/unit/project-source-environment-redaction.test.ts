import { describe, expect, test } from "bun:test";
import { parse, stringify } from "yaml";
import { inspectProjectSource } from "../../src/internal/core/project-source-security.ts";

function environmentReference(name: string): string {
	return ["$", "{", name, "}"].join("");
}

function projectSource(environmentVariables: Record<string, string> | string, provider = "bailian"): string {
	return stringify({
		version: "1",
		providers: { [provider]: { api_key: "" } },
		environments: { sandbox: { environment_id: "env_synthetic", config: { type: "cloud" } } },
		agents: {
			assistant: {
				model: "synthetic-model",
				instructions: "Keep a and info in ordinary text.",
				environment: "sandbox",
			},
		},
		deployments: {
			daily: {
				agent: "assistant",
				environment: "sandbox",
				initial_events: [{ type: "user.message", content: "Keep a and info in the initial event." }],
				metadata: { label: "a", log_level: "info" },
				environment_variables: environmentVariables,
			},
		},
	});
}

function previewDeployment(source: string): Record<string, unknown> {
	return parse(source).deployments.daily;
}

describe("display-only environment variable redaction", () => {
	test("keeps aliases valid when an Agent environment value defines an anchor", async () => {
		const source = `version: "1"
providers:
  qoder: {}
agents:
  assistant:
    model: synthetic-model
    instructions: Keep this configuration valid.
    environment_variables:
      MODE: &setting normal
    metadata:
      label: *setting
`;
		const inspected = await inspectProjectSource(source, "/tmp/display-only-environment/agents.yaml");
		const preview = parse(inspected.redacted_source).agents.assistant;
		expect(inspected.diagnostics).toEqual([]);
		expect(preview.environment_variables.MODE).toBe("[redacted]");
		expect(preview.metadata.label).toBe("[redacted]");
	});

	test("keeps aliases valid when a Qoder Deployment variable string defines an anchor", async () => {
		const source = `version: "1"
providers:
  qoder: {}
agents:
  assistant:
    model: synthetic-model
    instructions: Keep this configuration valid.
deployments:
  daily:
    agent: assistant
    initial_events:
      - type: user.message
        content: Run the daily task.
    environment_variables: &settings MODE=normal
    metadata:
      label: *settings
`;
		const inspected = await inspectProjectSource(source, "/tmp/display-only-environment/agents.yaml");
		const preview = previewDeployment(inspected.redacted_source);
		expect(inspected.diagnostics).toEqual([]);
		expect(preview.environment_variables).toBe("[redacted]");
		expect(preview.metadata).toEqual({ label: "[redacted]" });
	});

	test("masks all map literals without rewriting names, references or unrelated short values", async () => {
		const variables = {
			LOG_LEVEL: "info",
			EMPTY: "",
			KEY_WITH_A: "a",
			CUSTOM_VALUE: "fake=preview=sentinel",
			FROM_ENV: environmentReference("CUSTOM_VALUE"),
			API_KEY: environmentReference("DEPLOYMENT_API_KEY"),
		};
		const source = projectSource(variables);
		const inspected = await inspectProjectSource(source, "/tmp/display-only-environment/agents.yaml");
		const preview = previewDeployment(inspected.redacted_source);
		expect(preview.environment_variables).toEqual({
			LOG_LEVEL: "[redacted]",
			EMPTY: "[redacted]",
			KEY_WITH_A: "[redacted]",
			CUSTOM_VALUE: "[redacted]",
			FROM_ENV: environmentReference("CUSTOM_VALUE"),
			API_KEY: environmentReference("DEPLOYMENT_API_KEY"),
		});
		expect(preview.metadata).toEqual({ label: "a", log_level: "info" });
		expect(inspected.redacted_source).toContain("Keep a and info in ordinary text.");
		expect(inspected.redacted_source).toContain("Keep a and info in the initial event.");
		expect(inspected.redacted_source).not.toContain("fake=preview=sentinel");
		expect(inspected.sensitive_literals).toEqual([]);
		expect(inspected.diagnostics.some((diagnostic) => diagnostic.code === "project.version.sensitive_literal")).toBe(
			false,
		);
		expect(previewDeployment(source).environment_variables).toEqual(variables);
	});

	test("keeps credential-literal blocking independent from node-level display masking", async () => {
		const credential = "fake-credential-preview-secret";
		const project = parse(projectSource({ API_KEY: credential, LOG_LEVEL: "info" }));
		project.agents.assistant.instructions = `Copied credential ${credential}`;
		const source = `${stringify(project)}# Copied credential ${credential}\n`;
		const inspected = await inspectProjectSource(source, "/tmp/display-only-environment/agents.yaml");
		expect(previewDeployment(inspected.redacted_source).environment_variables).toEqual({
			API_KEY: "[redacted]",
			LOG_LEVEL: "[redacted]",
		});
		expect(previewDeployment(inspected.redacted_source).metadata).toEqual({ label: "a", log_level: "info" });
		expect(inspected.diagnostics.some((diagnostic) => diagnostic.code === "project.version.sensitive_literal")).toBe(
			true,
		);
		expect(inspected.sensitive_literals).toEqual(["[redacted]"]);
		expect(inspected.redacted_source).not.toContain(credential);
		expect(inspected.redacted_source).toContain("Copied credential [redacted]");
		expect(previewDeployment(source).environment_variables).toEqual({ API_KEY: credential, LOG_LEVEL: "info" });
	});

	test("masks Qoder string literals while retaining complete environment references", async () => {
		const literal = await inspectProjectSource(
			projectSource("LOG_LEVEL=info;VALUE=fake-preview-sentinel", "qoder"),
			"/tmp/display-only-environment/agents.yaml",
		);
		expect(previewDeployment(literal.redacted_source).environment_variables).toBe("[redacted]");
		const reference = projectSource(environmentReference("DEPLOYMENT_VARIABLES"), "qoder");
		const inspected = await inspectProjectSource(reference, "/tmp/display-only-environment/agents.yaml");
		expect(inspected.redacted_source).toBe(reference);
		expect(inspected.sensitive_literals).toEqual([]);
	});
});
