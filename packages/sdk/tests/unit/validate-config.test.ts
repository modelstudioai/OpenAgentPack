import { expect, test } from "bun:test";
import { collectConfigReferences, validateProjectConfig } from "../../src/internal/core/validate-config.ts";
import type { ProjectConfig } from "../../src/internal/types/config.ts";

// One fixture exercising both validation axes at once: an unknown skill reference
// (reference integrity) AND a Bailian MCP server without a tools.mcp entry
// (provider capability). The unified pipeline must surface both, and the
// Bailian-MCP rule must fire exactly once (it used to be duplicated).
function fixture(): ProjectConfig {
	return {
		version: "1",
		providers: { bailian: {} },
		defaults: { provider: "bailian" },
		agents: {
			assistant: {
				model: "qwen3.7-max",
				instructions: "test",
				tools: { builtin: ["read"] },
				skills: ["ghost-skill"],
				mcp_servers: [{ type: "official", name: "WebSearch" }],
			},
		},
	};
}

test("validateProjectConfig surfaces both reference and capability diagnostics", () => {
	const diagnostics = validateProjectConfig(fixture());

	const skillRef = diagnostics.filter((d) => d.code === "config.agent.skill.unknown");
	expect(skillRef).toHaveLength(1);
	expect(skillRef[0]?.message).toContain("ghost-skill");

	const bailianMcp = diagnostics.filter((d) => d.code === "bailian.agent.mcp_toolkit_missing");
	expect(bailianMcp).toHaveLength(1);
});

test("collectConfigReferences omits provider capability checks", () => {
	const diagnostics = collectConfigReferences(fixture());

	expect(diagnostics.some((d) => d.code === "config.agent.skill.unknown")).toBe(true);
	// References-only: the Bailian capability rule must NOT run here (webui playbooks use
	// server-only MCP that this rule would wrongly flag).
	expect(diagnostics.some((d) => d.code === "bailian.agent.mcp_toolkit_missing")).toBe(false);
});

test("validates tunnel references and limits tunnels to Qoder", () => {
	const config: ProjectConfig = {
		version: "1",
		providers: { claude: {} },
		defaults: { provider: "claude" },
		tunnels: { byoc: { tunnel_id: "tnl_1" } },
		agents: {
			assistant: { model: "claude", instructions: "test", tunnel: "byoc" },
		},
	};

	const diagnostics = validateProjectConfig(config);
	expect(diagnostics.some((d) => d.code === "claude.agent.tunnel.unsupported")).toBe(true);
});

test("limits Agent environment variables to Qoder", () => {
	const config: ProjectConfig = {
		version: "1",
		providers: { claude: {} },
		defaults: { provider: "claude" },
		agents: {
			assistant: {
				model: "claude",
				instructions: "test",
				environment_variables: { FEATURE_FLAG: "on" },
			},
		},
	};

	const diagnostics = validateProjectConfig(config);
	expect(diagnostics.some((d) => d.code === "claude.agent.environment_variables.unsupported")).toBe(true);
});

test("rejects tool approval and GitHub Session resources on unsupported providers", () => {
	const config: ProjectConfig = {
		version: "1",
		providers: { bailian: {} },
		defaults: { provider: "bailian" },
		agents: {
			assistant: {
				model: "qwen3.7-max",
				instructions: "test",
				tools: { builtin: ["bash"], default_permission: "ask" },
				resources: [
					{
						type: "github_repository",
						url: "https://github.com/acme/repo.git",
						authorization_token: "secret",
					},
				],
			},
		},
	};

	const diagnostics = validateProjectConfig(config);
	expect(diagnostics.some((item) => item.code === "bailian.agent.tool_permissions.unsupported")).toBe(true);
	expect(diagnostics.some((item) => item.code === "bailian.agent.session_resource.github_repository.unsupported")).toBe(
		true,
	);
});

test("rejects Qoder GitHub Session mount paths outside /data", () => {
	const diagnostics = validateProjectConfig({
		version: "1",
		providers: { qoder: { api_key: "test" } },
		defaults: { provider: "qoder" },
		environments: { dev: { config: { type: "cloud" } } },
		agents: {
			reviewer: {
				model: "auto",
				instructions: "Review",
				environment: "dev",
				resources: [
					{
						type: "github_repository",
						url: "https://github.com/acme/repo.git",
						authorization_token: "secret",
						mount_path: "/workspace/repo",
					},
				],
			},
		},
	});

	expect(diagnostics.some((item) => item.code === "qoder.agent.session_resource.mount_path.invalid")).toBe(true);
});

test("rejects Claude GitHub Session mount paths outside /workspace", () => {
	const diagnostics = validateProjectConfig({
		version: "1",
		providers: { claude: { api_key: "test" } },
		defaults: { provider: "claude" },
		environments: { dev: { config: { type: "cloud" } } },
		agents: {
			reviewer: {
				model: "sonnet",
				instructions: "Review",
				environment: "dev",
				resources: [
					{
						type: "github_repository",
						url: "https://github.com/acme/repo.git",
						authorization_token: "secret",
						mount_path: "/data/repo",
					},
				],
			},
		},
	});

	expect(diagnostics.some((item) => item.code === "claude.agent.session_resource.mount_path.invalid")).toBe(true);
});

test("allows setup_script on Qoder and rejects unsupported writable package declarations", () => {
	const diagnostics = validateProjectConfig({
		version: "1",
		providers: { qoder: { api_key: "test" } },
		defaults: { provider: "qoder" },
		environments: {
			dev: {
				config: {
					type: "cloud",
					setup_script: "echo ready",
					packages: { apt: ["curl"], cargo: ["ripgrep"] },
				},
			},
		},
	});

	expect(diagnostics.some((item) => item.code === "qoder.environment.setup_script.unsupported")).toBe(false);
	expect(diagnostics.find((item) => item.code === "qoder.environment.packages.unsupported")?.message).toContain(
		"cargo",
	);
});

test("rejects setup_script on unsupported managed providers but ignores external references", () => {
	const managed = validateProjectConfig({
		version: "1",
		providers: { claude: { api_key: "test" } },
		defaults: { provider: "claude" },
		environments: { dev: { config: { type: "cloud", setup_script: "echo ready" } } },
	});
	const external = validateProjectConfig({
		version: "1",
		providers: { claude: { api_key: "test" } },
		defaults: { provider: "claude" },
		environments: {
			dev: { environment_id: "env_external", config: { type: "cloud", setup_script: "echo inert" } },
		},
	});

	expect(managed.some((item) => item.code === "claude.environment.setup_script.unsupported")).toBe(true);
	expect(external.some((item) => item.code === "claude.environment.setup_script.unsupported")).toBe(false);
});

test("rejects networking and packages on managed Qoder self_hosted environments", () => {
	const diagnostics = validateProjectConfig({
		version: "1",
		providers: { qoder: { api_key: "test" } },
		defaults: { provider: "qoder" },
		environments: {
			byoc: {
				config: {
					type: "self_hosted",
					networking: { type: "unrestricted" },
					packages: { apt: ["curl"] },
					setup_script: "echo ready",
				},
			},
		},
	});

	expect(
		diagnostics.find((item) => item.code === "qoder.environment.self_hosted.config.unsupported")?.message,
	).toContain("only config.type and config.setup_script");
});
