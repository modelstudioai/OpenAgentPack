import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { loadConfig } from "../../src/internal/parser/index.ts";
import { buildPlan } from "../../src/internal/planner/planner.ts";
import { mapCredential, mapVault } from "../../src/internal/providers/qoder/mapper.ts";
import type { VaultDecl } from "../../src/internal/types/config.ts";
import type { StateFile } from "../../src/internal/types/state.ts";
import "../../src/internal/providers/qoder/index.ts";

const EXAMPLES = resolve(import.meta.dir, "../../../../examples");
const emptyState: StateFile = { resources: [] };

function staticBearerVault(overrides: Partial<VaultDecl> = {}): VaultDecl {
	return {
		display_name: "Cli Secrets",
		credentials: [
			{
				name: "mcp-token",
				type: "static_bearer",
				mcp_server_url: "https://mcp.example.com/github",
				access_token: "tok-123",
			},
		],
		...overrides,
	};
}

test("mapVault emits only display_name + metadata (credentials added separately)", () => {
	const body = mapVault("secrets", staticBearerVault(), "my-project") as Record<string, unknown>;

	expect(body.display_name).toBe("Cli Secrets");
	expect(body.metadata).toEqual({ "agents.project": "my-project", "agents.resource": "secrets" });
	expect(body.credentials).toBeUndefined();
});

test("mapVault merges user metadata with the project stamp", () => {
	const body = mapVault("secrets", staticBearerVault({ metadata: { team: "docs" } }), "my-project") as Record<
		string,
		unknown
	>;

	expect(body.metadata).toEqual({ "agents.project": "my-project", "agents.resource": "secrets", team: "docs" });
});

test("mapCredential nests static_bearer fields under auth with a `token`", () => {
	const cred = mapCredential({
		name: "mcp-token",
		type: "static_bearer",
		mcp_server_url: "https://mcp.example.com/github",
		access_token: "tok-123",
	}) as Record<string, unknown>;

	expect(cred).toEqual({
		auth: {
			type: "static_bearer",
			mcp_server_url: "https://mcp.example.com/github",
			token: "tok-123",
		},
		display_name: "mcp-token",
	});
});

test("mapCredential nests environment_variable fields under auth", () => {
	const cred = mapCredential({
		name: "DASHSCOPE_API_KEY",
		type: "environment_variable",
		secret_name: "DASHSCOPE_API_KEY",
		secret_value: "sk-xxx",
		networking: { type: "unrestricted" },
	}) as Record<string, unknown>;

	expect(cred).toEqual({
		auth: {
			type: "environment_variable",
			secret_name: "DASHSCOPE_API_KEY",
			secret_value: "sk-xxx",
			networking: { type: "unrestricted" },
		},
		display_name: "DASHSCOPE_API_KEY",
	});
});

test("qoder with-vault example loads and plans a vault create", async () => {
	const { config, errors } = await loadConfig(resolve(EXAMPLES, "qoder/with-vault/agents.yaml"));
	expect(errors).toEqual([]);

	const vault = config.vaults?.secrets;
	expect(vault?.credentials[0]?.type).toBe("static_bearer");
	expect(vault?.credentials[0]?.protocol).toBe("streamable_http");

	const plan = await buildPlan(config, emptyState);
	expect(plan.diagnostics).toEqual([]);
	expect(plan.actions.map((a) => `${a.action}:${a.address.type}:${a.address.name}`)).toEqual(["create:vault:secrets"]);
});
