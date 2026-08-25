import { describe, expect, test } from "bun:test";
import { inspectProjectSource } from "../src/services/project-source-security";

describe("project version source security", () => {
	test("allows environment references, preserves secret identifiers, and redacts preview values", async () => {
		const environmentReference = ["$", "{", "WORKBENCH_TOKEN", "}"].join("");
		const source = sourceWithSecret(environmentReference);
		const inspected = await inspectProjectSource(source, "/tmp/project/agents.yaml");

		expect(inspected.diagnostics.some((diagnostic) => diagnostic.code === "project.version.sensitive_literal")).toBe(
			false,
		);
		expect(inspected.redacted_source).not.toContain(environmentReference);
		expect(inspected.redacted_source).toContain("secret_name: SERVICE_TOKEN");
		expect(inspected.redacted_source).toContain("mcp-credentials:");
	});

	test("blocks literal values without returning the literal in source or diagnostics", async () => {
		const inspected = await inspectProjectSource(sourceWithSecret("literal-do-not-leak"), "/tmp/project/agents.yaml");

		expect(inspected.diagnostics.some((diagnostic) => diagnostic.code === "project.version.sensitive_literal")).toBe(
			true,
		);
		expect(JSON.stringify(inspected)).not.toContain("literal-do-not-leak");
		expect(inspected.redacted_source).toContain('access_token: "[redacted]"');
	});

	test("rejects environment references that embed a plaintext default", async () => {
		const environmentReferenceWithDefault = ["$", "{", "WORKBENCH_TOKEN", ":-literal-default}"].join("");
		const inspected = await inspectProjectSource(
			sourceWithSecret(environmentReferenceWithDefault),
			"/tmp/project/agents.yaml",
		);

		expect(inspected.diagnostics.some((diagnostic) => diagnostic.code === "project.version.sensitive_literal")).toBe(
			true,
		);
		expect(JSON.stringify(inspected)).not.toContain("literal-default");
	});

	test("redacts escaped sensitive scalars from the serialized safe preview", async () => {
		const source = sourceWithSecret('"literal\\u002dsecret"');
		const inspected = await inspectProjectSource(source, "/tmp/project/agents.yaml");

		expect(inspected.diagnostics.some((diagnostic) => diagnostic.code === "project.version.sensitive_literal")).toBe(
			true,
		);
		expect(inspected.redacted_source).toContain('access_token: "[redacted]"');
		expect(inspected.redacted_source).not.toContain("literal\\u002dsecret");
		expect(inspected.redacted_source).not.toContain("literal-secret");
	});

	test("omits malformed source instead of leaking multiline sensitive values", async () => {
		const source = `${sourceWithSecret("|\n          multiline-secret")}broken: "\n`;
		const inspected = await inspectProjectSource(source, "/tmp/project/agents.yaml");

		expect(inspected.diagnostics.some((diagnostic) => diagnostic.code === "project.config.invalid")).toBe(true);
		expect(inspected.redacted_source).toBe("# Invalid agents.yaml source omitted from the safe preview.\n");
		expect(JSON.stringify(inspected)).not.toContain("multiline-secret");
	});
});

function sourceWithSecret(accessToken: string): string {
	return `version: "1"
providers:
  qoder: {}
defaults:
  provider: qoder
vaults:
  mcp-credentials:
    display_name: MCP credentials
    credentials:
      - name: service
        type: static_bearer
        mcp_server_url: https://example.com/mcp
        secret_name: SERVICE_TOKEN
        access_token: ${accessToken}
agents:
  assistant:
    model: ultimate
    instructions: Help the user
    vault: mcp-credentials
`;
}
