// biome-ignore-all lint/suspicious/noTemplateCurlyInString: vault 引用语法字面量(${VAULT_*}),非 JS 模板插值
import { expect, test } from "bun:test";
import { projectConfigSchema } from "../../src/internal/parser/schema.ts";
import { credToDecl as bailianCred, vaultToDecl as bailianVault } from "../../src/internal/providers/bailian/mapper.ts";
import { credToDecl as claudeCred, vaultToDecl as claudeVault } from "../../src/internal/providers/claude/mapper.ts";
import { credToDecl as qoderCred, vaultToDecl as qoderVault } from "../../src/internal/providers/qoder/mapper.ts";

test("bailian credToDecl reverse-maps an environment_variable credential with a secret placeholder", () => {
	const raw = {
		id: "vcrd_1",
		display_name: "mcp-token",
		auth: { type: "environment_variable", secret_name: "API_KEY", networking: { type: "unrestricted" } },
	};

	expect(bailianCred(raw, "secrets")).toEqual({
		name: "mcp-token",
		type: "environment_variable",
		secret_name: "API_KEY",
		secret_value: "${VAULT_SECRETS_MCP_TOKEN}",
		networking: { type: "unrestricted" },
	});
});

test("bailian vaultToDecl strips agents.* metadata and keeps user metadata", () => {
	const rawVault = {
		id: "vlt_1",
		display_name: "Cli Secrets",
		metadata: { "agents.project": "p", "agents.resource": "secrets", team: "docs" },
	};
	const rawCreds = [
		{ id: "vcrd_1", display_name: "mcp-token", auth: { type: "environment_variable", secret_name: "API_KEY" } },
	];

	const decl = bailianVault(rawVault, rawCreds, "secrets");

	expect(decl.display_name).toBe("Cli Secrets");
	expect(decl.metadata).toEqual({ team: "docs" });
	expect((decl.credentials as Array<Record<string, unknown>>)[0]?.secret_value).toBe("${VAULT_SECRETS_MCP_TOKEN}");
});

test("qoder credToDecl reverse-maps a static_bearer credential and synthesizes a name", () => {
	const raw = {
		id: "vcred_1",
		display_name: null,
		auth: { type: "static_bearer", mcp_server_url: "https://mcp.example.com/github" },
	};

	expect(qoderCred(raw, "secrets", 0)).toEqual({
		name: "https-mcp-example-com-github",
		type: "static_bearer",
		mcp_server_url: "https://mcp.example.com/github",
		access_token: "${VAULT_SECRETS_HTTPS_MCP_EXAMPLE_COM_GITHUB}",
	});
});

test("qoder credToDecl reverse-maps an environment_variable credential (display_name is null)", () => {
	const raw = {
		id: "vcred_2",
		display_name: null,
		auth: { type: "environment_variable", secret_name: "DASHSCOPE_API_KEY", networking: {} },
	};

	expect(qoderCred(raw, "secrets", 0)).toEqual({
		name: "DASHSCOPE_API_KEY",
		type: "environment_variable",
		secret_name: "DASHSCOPE_API_KEY",
		secret_value: "${VAULT_SECRETS_DASHSCOPE_API_KEY}",
	});
});

test("claude credToDecl reverse-maps static_bearer and environment_variable, and skips mcp_oauth", () => {
	const bearer = claudeCred(
		{ display_name: "Linear", auth: { type: "static_bearer", mcp_server_url: "https://mcp.linear.app/mcp" } },
		"alice",
	);
	expect(bearer).toEqual({
		name: "Linear",
		type: "static_bearer",
		mcp_server_url: "https://mcp.linear.app/mcp",
		access_token: "${VAULT_ALICE_LINEAR}",
	});

	const envVar = claudeCred(
		{
			display_name: "Notion",
			auth: {
				type: "environment_variable",
				secret_name: "NOTION_API_KEY",
				networking: { type: "limited", allowed_hosts: ["api.notion.com"] },
			},
		},
		"alice",
	);
	expect(envVar).toEqual({
		name: "Notion",
		type: "environment_variable",
		secret_name: "NOTION_API_KEY",
		secret_value: "${VAULT_ALICE_NOTION}",
		networking: { type: "limited" },
	});

	// mcp_oauth cannot be expressed in the agents credential schema.
	expect(
		claudeCred(
			{ display_name: "Slack", auth: { type: "mcp_oauth", mcp_server_url: "https://mcp.slack.com/mcp" } },
			"alice",
		),
	).toBeNull();
});

test("claude vaultToDecl drops mcp_oauth credentials and keeps the rest", () => {
	const decl = claudeVault(
		{ display_name: "Alice", metadata: { "agents.resource": "alice", external_user_id: "usr_abc123" } },
		[
			{ display_name: "Linear", auth: { type: "static_bearer", mcp_server_url: "https://mcp.linear.app/mcp" } },
			{ display_name: "Slack", auth: { type: "mcp_oauth", mcp_server_url: "https://mcp.slack.com/mcp" } },
		],
		"alice",
	);
	expect((decl.credentials as unknown[]).length).toBe(1);
	expect(decl.metadata).toEqual({ external_user_id: "usr_abc123" });
});

test("synced vault decls conform to the plan/apply config schema", () => {
	const bailianDecl = bailianVault(
		{ display_name: "Cli Secrets", metadata: {} },
		[{ display_name: "mcp-token", auth: { type: "environment_variable", secret_name: "API_KEY" } }],
		"secrets",
	);
	const qoderDecl = qoderVault(
		{ display_name: "Qoder Secrets" },
		[{ display_name: "mcp-token", auth: { type: "static_bearer", mcp_server_url: "https://mcp.example.com/x" } }],
		"qsecrets",
	);

	const result = projectConfigSchema.safeParse({
		version: "1",
		providers: { bailian: {}, qoder: {} },
		vaults: {
			secrets: { ...bailianDecl, provider: "bailian" },
			qsecrets: { ...qoderDecl, provider: "qoder" },
		},
	});

	expect(result.success).toBe(true);
});
