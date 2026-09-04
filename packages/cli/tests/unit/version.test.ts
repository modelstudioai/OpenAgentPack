import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDirectoryWorkspaceVersionService } from "@openagentpack/project-workspace";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const directories: string[] = [];

afterEach(async () => {
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("agents project version", () => {
	test("project init creates a Git-independent baseline and shared local switch", async () => {
		const root = await temporaryDirectory();
		const initialized = await runAgents(["project", "init", "--project", root, "--json"]);

		expect(initialized.exitCode).toBe(0);
		const body = JSON.parse(initialized.stdout);
		expect(body.baseline_version).toMatch(/^[a-f0-9]{64}$/);
		const status = await runAgents(["project", "version", "status", "--project", root, "--json"]);
		expect(status.exitCode).toBe(0);
		const versioning = JSON.parse(status.stdout);
		expect(versioning.enabled).toBe(true);
		expect(versioning.store_root).toBe(join(root, ".openagentpack/versions/project"));
		expect(versioning.source_status).toBe("clean");
	});

	test("list, preview, and restore operate on the complete directory source without changing State", async () => {
		const root = await initializedProject();
		const instructionsPath = join(root, "agents/assistant/instructions.md");
		const statePath = join(root, ".openagentpack/state.json");
		const baseline = (await createDirectoryWorkspaceVersionService(root).status()).head_version!;
		await chmod(instructionsPath, 0o640);
		await writeFile(statePath, '{"remote":"latest"}\n');
		await writeFile(instructionsPath, "Version two\n");
		await mkdir(join(root, "assets"));
		await writeFile(join(root, "assets/icon.bin"), new Uint8Array([0, 1, 2]));

		const service = createDirectoryWorkspaceVersionService(root);
		const prepared = await service.prepareVersion();
		const second = await service.commitPrepared(prepared, "Publish project");
		if (!second) throw new Error("Expected a changed directory snapshot.");
		expect(second.version_id).toMatch(/^[a-f0-9]{64}$/);

		const listed = await runAgents(["project", "version", "list", "--project", root, "--json"]);
		expect(JSON.parse(listed.stdout).versions.map((version: { message: string }) => version.message)).toEqual([
			"Publish project",
			"Initialize project",
		]);
		const abbreviated = await runAgents(["project", "version", "preview", baseline.slice(0, 12), "--project", root]);
		expect(abbreviated.exitCode).toBe(1);
		expect(abbreviated.stderr).toContain("full 64-character");

		const preview = await runAgents(["project", "version", "preview", baseline, "--project", root]);
		expect(preview.exitCode).toBe(0);
		expect(preview.stdout).toContain("update agents/assistant/instructions.md");
		expect(preview.stdout).toContain("delete assets/icon.bin (binary)");
		const restored = await runAgents(["project", "version", "restore", baseline, "--project", root, "--yes", "--json"]);
		expect(restored.exitCode).toBe(0);
		expect(await readFile(instructionsPath, "utf8")).toBe("You are a helpful assistant.\n");
		expect(await stat(join(root, "assets/icon.bin")).catch(() => null)).toBeNull();
		expect(await readFile(statePath, "utf8")).toBe('{"remote":"latest"}\n');
		expect((await stat(instructionsPath)).mode & 0o777).toBe(0o644);
		expect((await service.status()).head_version).toBe(second.version_id);
	});

	test("project build renders directory source changes against the current version head", async () => {
		const root = await initializedProject();
		const initialBuild = await runAgents(["project", "build", "--project", root, "--yes"]);
		expect(initialBuild.exitCode).toBe(0);

		await writeFile(join(root, "agents/assistant/instructions.md"), "Changed while offline.\n");
		const preview = await runAgents(["project", "build", "--project", root, "--dry-run"]);

		expect(preview.exitCode).toBe(0);
		expect(preview.stdout).toContain("Project source changes");
		expect(preview.stdout).toMatch(/baseline [a-f0-9]{12} -> working tree/);
		expect(preview.stdout).toContain("update agents/assistant/instructions.md");
		expect(preview.stdout).toContain("-You are a helpful assistant.");
		expect(preview.stdout).toContain("+Changed while offline.");
		expect(preview.stdout).not.toContain("Generated YAML changes");
		expect(preview.stdout).not.toContain("generated agents.yaml");
	});

	test("enable and disable share one switch and do not remove version history", async () => {
		const root = await initializedProject();
		const before = await runAgents(["project", "version", "list", "--project", root, "--json"]);
		const disabled = await runAgents(["project", "version", "disable", "--project", root, "--json"]);
		expect(JSON.parse(disabled.stdout).enabled).toBe(false);

		const enabled = await runAgents(["project", "version", "enable", "--project", root, "--json"]);
		expect(JSON.parse(enabled.stdout).versioning.enabled).toBe(true);
		const after = await runAgents(["project", "version", "list", "--project", root, "--json"]);
		expect(JSON.parse(after.stdout).versions).toEqual(JSON.parse(before.stdout).versions);
	});

	test("sensitive literals block snapshots without leaking the value", async () => {
		const root = await initializedProject();
		await runAgents(["project", "version", "disable", "--project", root, "--json"]);
		const agentPath = join(root, "agents/assistant/agent.json");
		const agent = JSON.parse(await readFile(agentPath, "utf8"));
		agent.vault = "secrets";
		await writeFile(agentPath, `${JSON.stringify(agent, null, 2)}\n`);
		await mkdir(join(root, "agents/assistant/vaults/secrets"), { recursive: true });
		await writeFile(
			join(root, "agents/assistant/vaults/secrets/vault.json"),
			`${JSON.stringify(
				{
					id: "secrets",
					display_name: "Secrets",
					credentials: [
						{
							name: "bearer",
							type: "static_bearer",
							mcp_server_url: "https://example.com/mcp",
							access_token: "literal-do-not-leak",
						},
					],
				},
				null,
				2,
			)}\n`,
		);

		const result = await runAgents(["project", "version", "enable", "--project", root, "--json"]);
		expect(result.exitCode).toBe(1);
		expect(`${result.stdout}${result.stderr}`).not.toContain("literal-do-not-leak");
		expect(result.stderr).toContain("environment variable reference");
	});

	test("help exposes versions only below project and has no Git or manual create command", async () => {
		const rootHelp = await runAgents(["--help"]);
		expect(rootHelp.stdout).not.toMatch(/^\s+version\b/m);
		expect(rootHelp.stdout).not.toMatch(/^\s+workbench\b/m);
		const initHelp = await runAgents(["project", "init", "--help"]);
		expect(initHelp.stdout).not.toContain("--provider");

		const result = await runAgents(["project", "version", "--help"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("enable");
		expect(result.stdout).toContain("restore");
		expect(result.stdout).not.toContain("Git");
		expect(result.stdout).not.toMatch(/^\s+create\b/m);

		const versionHelp = await runAgents(["project", "version", "status", "--help"]);
		expect(versionHelp.stdout).toContain("--project <directory>");
		expect(versionHelp.stdout).not.toContain("--file");
	});
});

async function initializedProject(): Promise<string> {
	const root = await temporaryDirectory();
	const result = await runAgents(["project", "init", "--project", root, "--json"]);
	if (result.exitCode !== 0) throw new Error(result.stderr);
	return root;
}

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "agents-cli-project-version-"));
	directories.push(directory);
	return directory;
}

async function runAgents(args: string[]) {
	const processHandle = Bun.spawn([process.execPath, "run", join(REPO_ROOT, "packages/cli/bin/agents.ts"), ...args], {
		cwd: REPO_ROOT,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(processHandle.stdout).text(),
		new Response(processHandle.stderr).text(),
		processHandle.exited,
	]);
	return { stdout, stderr, exitCode };
}
