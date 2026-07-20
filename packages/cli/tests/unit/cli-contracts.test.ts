import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "agents-cli-contracts-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop()!;
		await rm(dir, { recursive: true, force: true });
	}
});

async function writeConfig(dir: string): Promise<string> {
	const configPath = join(dir, "agents.yaml");
	await Bun.write(
		configPath,
		`version: "1"

providers:
  claude:
    api_key: sk-test

defaults:
  provider: claude

agents:
  assistant:
    model: claude-sonnet-4-6
    instructions: "You are helpful."
`,
	);
	return configPath;
}

async function writeDeploymentConfig(dir: string): Promise<string> {
	const configPath = await writeConfig(dir);
	await Bun.write(
		configPath,
		`version: "1"

providers:
  claude:
    api_key: sk-test

defaults:
  provider: claude

agents:
  assistant:
    model: claude-sonnet-4-6
    instructions: "You are helpful."

deployments:
  daily-assistant:
    agent: assistant
    schedule:
      expression: "0 9 * * *"
      timezone: "Asia/Shanghai"
    initial_events:
      - type: user.message
        content: "daily run"
`,
	);
	return configPath;
}

async function writeBailianVaultConfig(dir: string): Promise<string> {
	const configPath = join(dir, "agents.yaml");
	await Bun.write(
		configPath,
		`version: "1"

providers:
  bailian:
    api_key: test-key
    workspace_id: test-workspace
    base_url: http://127.0.0.1:1

defaults:
  provider: bailian

vaults:
  secrets:
    display_name: Secrets
    credentials:
      - name: token
        mcp_server_url: https://example.com/mcp
        type: static_bearer
        access_token: test-token
`,
	);
	await Bun.write(
		join(dir, "agents.state.json"),
		JSON.stringify({
			resources: [
				{
					address: { type: "vault", name: "secrets", provider: "bailian" },
					remote_id: "vault_123",
					content_hash: "hash",
				},
			],
		}),
	);
	return configPath;
}

async function runAgents(args: string[], env: Record<string, string> = {}, cwd = REPO_ROOT) {
	const entry = cwd === REPO_ROOT ? "bin/agents.ts" : join(REPO_ROOT, "bin/agents.ts");
	const proc = Bun.spawn([process.execPath, "run", entry, ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			NO_COLOR: "1",
			FORCE_COLOR: "0",
			...env,
		},
	});

	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);

	return { stdout, stderr, exitCode };
}

test("root version output matches package version", async () => {
	const manifest = (await Bun.file(join(REPO_ROOT, "package.json")).json()) as { version: string };
	const result = await runAgents(["--version"]);

	expect(result.exitCode).toBe(0);
	expect(result.stdout).toBe(`${manifest.version}\n`);
	expect(result.stderr).toBe("");
});

test("version does not load credentials from a malformed config.json", async () => {
	const dir = await makeTempDir();
	const badConfig = join(dir, "bad-config.json");
	await Bun.write(badConfig, "this is not valid json {{{");

	const result = await runAgents(["--version"], { AGENTS_CONFIG_PATH: badConfig });

	expect(result.exitCode).toBe(0);
	expect(result.stderr).toBe("");
});

test("help does not load credentials from a malformed config.json", async () => {
	const dir = await makeTempDir();
	const badConfig = join(dir, "bad-config.json");
	await Bun.write(badConfig, '{"AGENTS_PROVIDER":"bogus"}');

	const result = await runAgents(["--help"], { AGENTS_CONFIG_PATH: badConfig });

	expect(result.exitCode).toBe(0);
	expect(result.stderr).not.toContain("Failed to load");
});

test("session run exposes an explicit Forward identity override", async () => {
	const result = await runAgents(["session", "run", "--help"]);

	expect(result.exitCode).toBe(0);
	expect(result.stdout).toContain("--identity-id <id>");
	expect(result.stdout).toContain("--stream");
	expect(result.stdout).not.toContain("--no-stream");
});

test("session send exposes explicit streaming as an opt-in", async () => {
	const result = await runAgents(["session", "send", "--help"]);

	expect(result.exitCode).toBe(0);
	expect(result.stdout).toContain("--stream");
	expect(result.stdout).not.toContain("--no-stream");
});

test("global --file before plan selects the config file", async () => {
	const dir = await makeTempDir();
	const configPath = await writeConfig(dir);

	const result = await runAgents(["--file", configPath, "plan", "--json"]);

	expect(result.exitCode).toBe(0);
	expect(result.stderr).toBe("");
	const plan = JSON.parse(result.stdout);
	expect(plan.actions.some((a: any) => a.address.name === "assistant")).toBe(true);
});

test("global -f before state list selects the derived state file", async () => {
	const dir = await makeTempDir();
	const configPath = await writeConfig(dir);
	await Bun.write(
		join(dir, "agents.state.json"),
		JSON.stringify({
			resources: [
				{
					address: { type: "agent", name: "assistant", provider: "claude" },
					remote_id: "agent_123",
					content_hash: "hash",
				},
			],
		}),
	);

	const result = await runAgents(["-f", configPath, "state", "list"]);

	expect(result.exitCode).toBe(0);
	expect(result.stdout).toContain("assistant");
	expect(result.stdout).toContain("agent_123");
});

test("command-level --file remains supported", async () => {
	const dir = await makeTempDir();
	const configPath = await writeConfig(dir);

	const result = await runAgents(["plan", "--file", configPath, "--json"]);

	expect(result.exitCode).toBe(0);
	expect(result.stderr).toBe("");
	expect(() => JSON.parse(result.stdout)).not.toThrow();
});

test("refresh warnings render after spinner completion", async () => {
	const dir = await makeTempDir();
	const configPath = await writeBailianVaultConfig(dir);

	const result = await runAgents(["plan", "--file", configPath]);

	expect(result.exitCode).toBe(0);
	expect(result.stderr).toContain("State refreshed.");
	expect(result.stderr).toContain("vault.secrets (bailian)");
	expect(result.stderr).not.toContain("Refreshing state...⚠");
	expect(result.stderr).not.toContain("State refreshed.⚠");
	expect(result.stdout).not.toContain("State refreshed.");
});

test("plan surfaces unverified (drift-unchecked) resources instead of implying in-sync", async () => {
	const dir = await makeTempDir();
	const configPath = join(dir, "agents.yaml");
	await Bun.write(
		configPath,
		`version: "1"

providers:
  bailian:
    api_key: test-key
    workspace_id: test-workspace

defaults:
  provider: bailian

vaults:
  secrets:
    display_name: Secrets
    credentials:
      - name: token
        mcp_server_url: https://example.com/mcp
        type: static_bearer
        access_token: test-token
`,
	);

	// Step 1: with no state file the vault is a "create" — capture the hash the
	// planner computes so we can seed a matching (no-op) state in step 2.
	const created = await runAgents(["plan", "--file", configPath, "--json"]);
	expect(created.exitCode).toBe(0);
	const createPlan = JSON.parse(created.stdout);
	const createAction = createPlan.actions.find((a: any) => a.address.name === "secrets" && a.action === "create");
	expect(createAction).toBeTruthy();
	const matchingHash = createAction.after.content_hash as string;

	// Step 2: seed state with the matching hash so the vault is a no-op. Bailian
	// reports "existence" drift for vaults, so refresh marks it unchecked on success
	// or leaves it unchanged on API failure. Pre-set drift_status to test the
	// surface behavior.
	await Bun.write(
		join(dir, "agents.state.json"),
		JSON.stringify({
			resources: [
				{
					address: { type: "vault", name: "secrets", provider: "bailian" },
					remote_id: "vault_123",
					content_hash: matchingHash,
					drift_status: "unchecked",
				},
			],
		}),
	);

	const result = await runAgents(["plan", "--file", configPath, "--refresh", "false"]);

	expect(result.exitCode).toBe(0);
	// The loop is closed: the unchecked resource is surfaced in the human plan...
	expect(result.stdout).toContain("Unverified");
	expect(result.stdout).toContain("vault.secrets (bailian)");
	// ...and the plan no longer falsely claims everything is in sync.
	expect(result.stdout).not.toContain("Infrastructure is up-to-date");
});

test("conflicting global and command-level file options fail clearly", async () => {
	const dir = await makeTempDir();
	const configPath = await writeConfig(dir);
	const otherPath = join(dir, "other.yaml");
	await Bun.write(otherPath, await Bun.file(configPath).text());

	const result = await runAgents(["--file", configPath, "plan", "--file", otherPath]);

	expect(result.exitCode).toBe(1);
	expect(result.stdout).toBe("");
	expect(result.stderr).toContain("Conflicting config files");
});

test("invalid provider fails before producing a human plan", async () => {
	const dir = await makeTempDir();
	const configPath = await writeConfig(dir);

	const result = await runAgents(["plan", "--file", configPath, "--provider", "wat"]);

	expect(result.exitCode).toBe(1);
	expect(result.stdout).not.toContain("Planned actions");
	expect(result.stderr).toContain("Allowed choices");
});

test("invalid provider in json mode does not emit a successful plan object", async () => {
	const dir = await makeTempDir();
	const configPath = await writeConfig(dir);

	const result = await runAgents(["plan", "--file", configPath, "--provider", "wat", "--json"]);

	expect(result.exitCode).toBe(1);
	expect(result.stdout).toBe("");
	expect(result.stderr).toContain("Allowed choices");
});

test("playground provider accepts registered providers and rejects unknown ones", async () => {
	const help = await runAgents(["playground", "--help"]);
	expect(help.exitCode).toBe(0);
	for (const provider of ["ark", "bailian", "claude", "qoder"]) {
		expect(help.stdout).toContain(provider);
	}

	const unsupported = await runAgents(["playground", "--provider", "wat", "--no-open"]);
	expect(unsupported.exitCode).toBe(1);
	expect(unsupported.stdout).toBe("");
	expect(unsupported.stderr).toContain("Allowed choices");
	expect(unsupported.stderr).not.toContain("Fetching @openagentpack/playground");

	// --help short-circuits before launch; confirms commander choices accept qoder/ark/claude.
	for (const provider of ["qoder", "ark", "claude"] as const) {
		const accepted = await runAgents(["playground", "--provider", provider, "--help"]);
		expect(accepted.exitCode).toBe(0);
		expect(accepted.stderr).not.toContain("Allowed choices");
	}
});

test("state import resource version does not invoke root version output", async () => {
	const dir = await makeTempDir();
	const configPath = await writeConfig(dir);

	const result = await runAgents([
		"state",
		"import",
		"claude.agent.assistant",
		"agent_remote",
		"--resource-version",
		"3",
		"--file",
		configPath,
	]);

	expect(result.exitCode).toBe(0);
	expect(result.stdout).toBe("");
	expect(result.stderr).toContain("Imported claude.agent.assistant");

	const state = await Bun.file(join(dir, "agents.state.json")).json();
	expect(state.resources[0].version).toBe(3);
	expect(state.resources[0].content_hash).toBeTruthy();
	expect(state.resources[0].desired_hash).toBe(state.resources[0].content_hash);

	const plan = await runAgents(["plan", "--file", configPath, "--refresh", "false", "--json"]);
	expect(plan.exitCode).toBe(0);
	const body = JSON.parse(plan.stdout);
	expect(body.actions.filter((a: any) => a.action !== "no-op")).toEqual([]);
});

test("deployment list renders deployment rows through the core runtime", async () => {
	const dir = await makeTempDir();
	const configPath = await writeDeploymentConfig(dir);
	await Bun.write(
		join(dir, "agents.state.json"),
		JSON.stringify({
			resources: [
				{
					address: { type: "deployment", name: "daily-assistant", provider: "claude" },
					remote_id: "deployment_123",
					content_hash: "hash",
				},
			],
		}),
	);

	const result = await runAgents(["deployment", "list", "--file", configPath]);

	expect(result.exitCode).toBe(0);
	expect(result.stdout).toContain("daily-assistant");
	expect(result.stdout).toContain("deployment_123");
	expect(result.stdout).toContain("0 9 * * *");
	expect(result.stdout).toContain("Name");
	expect(result.stdout).toContain("Provider");
	expect(result.stdout).toContain("Remote ID");
	expect(result.stdout).toContain("Schedule");
	expect(result.stdout).not.toMatch(/[\u4e00-\u9fff]/);
});

test("destroy with empty state is handled through the core runtime", async () => {
	const dir = await makeTempDir();
	const configPath = await writeConfig(dir);

	const result = await runAgents(["destroy", "--file", configPath, "--yes"]);

	expect(result.exitCode).toBe(0);
	expect(result.stdout).toBe("");
	expect(result.stderr).toContain("No resources in state");
});

test("validate reports reference errors through the core runtime", async () => {
	const dir = await makeTempDir();
	const configPath = await writeConfig(dir);
	const content = await Bun.file(configPath).text();
	await Bun.write(
		configPath,
		content.replace('instructions: "You are helpful."', 'instructions: "You are helpful."\n    environment: ghost'),
	);

	const result = await runAgents(["validate", "--file", configPath]);

	expect(result.exitCode).toBe(1);
	expect(result.stderr).toContain("references unknown environment 'ghost'");
});

test("validate loads .env before resolving provider placeholders", async () => {
	const dir = await makeTempDir();
	await Bun.write(
		join(dir, "agents.yaml"),
		`version: "1"

providers:
  qoder:
    api_key: \${QODER_PAT}

defaults:
  provider: qoder

agents:
  assistant:
    model: ultimate
    instructions: "You are helpful."
`,
	);
	await Bun.write(join(dir, ".env"), "QODER_PAT=test-token\n");

	const result = await runAgents(["validate", "--file", "agents.yaml"], { QODER_PAT: "" }, dir);

	expect(result.exitCode).toBe(0);
	expect(result.stderr).toContain("Configuration is valid");
});

test("models list keeps missing config guidance in the core runtime", async () => {
	const result = await runAgents(["models", "list", "--file", "/missing/agents.yaml"]);

	expect(result.exitCode).toBe(1);
	expect(result.stdout).toBe("");
	expect(result.stderr).toContain("File not found");
});

test("models list JSON reports providers without dynamic listing support", async () => {
	const dir = await makeTempDir();
	const configPath = await writeBailianVaultConfig(dir);

	const result = await runAgents(["models", "list", "--file", configPath, "--provider", "bailian", "--json"]);

	expect(result.exitCode).toBe(0);
	expect(JSON.parse(result.stdout)).toEqual({
		provider: "bailian",
		supportsDynamicListing: false,
		models: [],
	});
	expect(result.stderr).toBe("");
});

test("migrated CLI commands consume core service APIs instead of composing internals", async () => {
	const commands = ["destroy.ts", "session.ts", "state.ts", "deployment.ts", "validate.ts", "models.ts"];
	const banned = [
		"buildProviders",
		"loadConfig",
		"resolveFileReferences",
		"StateManager",
		"resolveDeploymentRefs",
		"buildDependencyGraph",
		"topologicalSort",
		"findMissingBailianMcpToolConfigs",
		"loadAdapterForDirectOp",
		"allProviders",
		"registerProvider",
		"getProvider",
	];

	for (const command of commands) {
		const source = await readFile(resolve(REPO_ROOT, "src/commands", command), "utf8");
		for (const symbol of banned) {
			expect(source).not.toContain(symbol);
		}
	}
});

test("provider option choices use core provider discovery instead of registry internals", async () => {
	const source = await readFile(resolve(REPO_ROOT, "src/runtime.ts"), "utf8");

	expect(source).toContain("listProviderNames");
	expect(source).not.toContain("allProviders");
});

test("json-mode user errors are written to stderr with empty stdout", async () => {
	const result = await runAgents(["plan", "--file", "/missing/agents.yaml", "--json"]);

	expect(result.exitCode).toBe(1);
	expect(result.stdout).toBe("");
	expect(result.stderr).toContain("File not found");
});

test("session run defaults to polling and reports missing applied resources through the core runtime", async () => {
	const dir = await makeTempDir();
	const configPath = await writeConfig(dir);

	const result = await runAgents(["session", "run", "assistant", "hello", "--file", configPath]);

	expect(result.exitCode).toBe(1);
	expect(result.stdout).toBe("");
	expect(result.stderr).toContain("Run `agents apply` first");
});

test("global --quiet suppresses non-error output from validate", async () => {
	const dir = await makeTempDir();
	const configPath = await writeConfig(dir);
	const content = await Bun.file(configPath).text();
	await Bun.write(
		configPath,
		content.replace('instructions: "You are helpful."', 'instructions: "You are helpful."\n    environment: ghost'),
	);

	const result = await runAgents(["--quiet", "validate", "--file", configPath]);

	expect(result.exitCode).toBe(1);
	expect(result.stderr).toContain("references unknown environment 'ghost'");
	expect(result.stderr).not.toContain("Validating");
});

test("global --no-color disables colored output", async () => {
	const result = await runAgents(["--no-color", "validate", "--file", "/missing/agents.yaml"]);

	expect(result.exitCode).toBe(1);
	expect(result.stderr).not.toContain("\x1b[");
});
