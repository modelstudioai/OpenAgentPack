import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { commitPreparedProjectVersion, prepareProjectVersion } from "../../src/versioning/project-versions";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const directories: string[] = [];
const testEnvironment = { QODER_PAT: "test-qoder-token" };

afterEach(async () => {
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("agents version", () => {
	test("enable creates a Git-independent baseline snapshot and a shared local switch", async () => {
		const root = await temporaryDirectory();
		const configPath = join(root, "agents.yaml");
		await writeFile(configPath, projectYaml("Baseline"));

		const enabled = await runAgents(["version", "enable", "--file", configPath, "--json"], testEnvironment);

		expect(enabled.exitCode).toBe(0);
		const body = JSON.parse(enabled.stdout);
		expect(body.versioning.enabled).toBe(true);
		expect(body.versioning.store_root).toBe(join(await realpath(root), ".openagentpack", "versions"));
		expect(body.version.message).toBe("Enable OpenAgentPack versioning");
		expect(
			await readFile(join(body.versioning.store_root, "blobs", `${body.version.source_hash}.yaml`), "utf8"),
		).toContain("Baseline");

		const repeated = await runAgents(["version", "enable", "--file", configPath, "--json"], testEnvironment);
		expect(repeated.exitCode).toBe(0);
		expect(JSON.parse(repeated.stdout).version).toBeNull();
	});

	test("enable and disable are isolated by agents.yaml directory", async () => {
		const firstRoot = await temporaryDirectory();
		const secondRoot = await temporaryDirectory();
		const firstPath = join(firstRoot, "agents.yaml");
		const secondPath = join(secondRoot, "agents.yaml");
		await writeFile(firstPath, projectYaml("First"));
		await writeFile(secondPath, projectYaml("Second"));

		await runAgents(["version", "enable", "--file", firstPath, "--json"], testEnvironment);
		await runAgents(["version", "enable", "--file", secondPath, "--json"], testEnvironment);
		const disabled = await runAgents(["version", "disable", "--file", firstPath, "--json"], testEnvironment);
		const secondStatus = await runAgents(["version", "status", "--file", secondPath, "--json"], testEnvironment);

		expect(JSON.parse(disabled.stdout).enabled).toBe(false);
		expect(JSON.parse(secondStatus.stdout).enabled).toBe(true);
	});

	test("list, preview, and restore use full local version IDs without changing State", async () => {
		const root = await temporaryDirectory();
		const configPath = join(root, "agents.yaml");
		const statePath = join(root, "agents.state.json");
		await writeFile(configPath, projectYaml("Version one"));
		await chmod(configPath, 0o640);
		await writeFile(statePath, '{"remote":"latest"}\n');
		const enabled = await runAgents(["version", "enable", "--file", configPath, "--json"], testEnvironment);
		const firstVersion = JSON.parse(enabled.stdout).version.version_id as string;

		const secondSource = projectYaml("Version two");
		await writeFile(configPath, secondSource, { mode: 0o640 });
		const prepared = await prepareProjectVersion(configPath, secondSource);
		await commitPreparedProjectVersion(prepared!);

		const listed = await runAgents(["version", "list", "--file", configPath, "--json"], testEnvironment);
		expect(JSON.parse(listed.stdout).versions.map((version: { message: string }) => version.message)).toEqual([
			"Apply agents.yaml",
			"Enable OpenAgentPack versioning",
		]);
		const abbreviated = await runAgents(
			["version", "preview", firstVersion.slice(0, 12), "--file", configPath],
			testEnvironment,
		);
		expect(abbreviated.exitCode).toBe(1);
		expect(abbreviated.stderr).toContain("64-character hexadecimal");

		const preview = await runAgents(["version", "preview", firstVersion, "--file", configPath], testEnvironment);
		expect(preview.exitCode).toBe(0);
		expect(preview.stdout).toContain("-    instructions: Version two");
		expect(preview.stdout).toContain("+    instructions: Version one");
		const restored = await runAgents(
			["version", "restore", firstVersion, "--file", configPath, "--yes", "--json"],
			testEnvironment,
		);
		expect(restored.exitCode).toBe(0);
		expect(await readFile(configPath, "utf8")).toContain("Version one");
		expect(await readFile(statePath, "utf8")).toBe('{"remote":"latest"}\n');
		expect((await stat(configPath)).mode & 0o777).toBe(0o640);
	});

	test("successful no-op Apply snapshots dirty YAML only when versioning is enabled", async () => {
		const root = await temporaryDirectory();
		const configPath = join(root, "agents.yaml");
		await writeFile(configPath, projectYaml("Initial"));
		await runAgents(["version", "enable", "--file", configPath, "--json"], testEnvironment);
		await writeFile(configPath, projectYaml("Applied change"));
		await seedMatchingAgentState(root, configPath);

		const applied = await runAgents(["apply", "--file", configPath, "--refresh", "false", "--yes"], testEnvironment);
		expect(applied.exitCode).toBe(0);
		expect(applied.stderr).toContain("Created local version");
		const listAfterApply = await runAgents(["version", "list", "--file", configPath, "--json"], testEnvironment);
		expect(JSON.parse(listAfterApply.stdout).versions[0].message).toBe("Apply agents.yaml");

		await runAgents(["version", "disable", "--file", configPath, "--json"], testEnvironment);
		await writeFile(configPath, projectYaml("Disabled change"));
		await seedMatchingAgentState(root, configPath);
		await runAgents(["apply", "--file", configPath, "--refresh", "false", "--yes"], testEnvironment);
		const listAfterDisabledApply = await runAgents(
			["version", "list", "--file", configPath, "--json"],
			testEnvironment,
		);
		expect(JSON.parse(listAfterDisabledApply.stdout).versions[0].message).toBe("Apply agents.yaml");
	});

	test("an Apply-time YAML race preserves recovery guidance", async () => {
		const root = await temporaryDirectory();
		const configPath = join(root, "agents.yaml");
		await writeFile(configPath, projectYaml("Initial"));
		await runAgents(["version", "enable", "--file", configPath, "--json"], testEnvironment);
		const expectedSource = projectYaml("Expected");
		await writeFile(configPath, expectedSource);
		const prepared = await prepareProjectVersion(configPath, expectedSource);
		await writeFile(configPath, projectYaml("Concurrent edit"));

		await expect(commitPreparedProjectVersion(prepared!)).rejects.toThrow(
			"Remote Apply completed, but agents.yaml could not be versioned",
		);
	});

	test("sensitive literals block enable without leaking the value or creating a store", async () => {
		const root = await temporaryDirectory();
		const configPath = join(root, "agents.yaml");
		const qoderReference = ["api_key: $", "{QODER_PAT}"].join("");
		await writeFile(configPath, projectYaml("Unsafe").replace(qoderReference, "api_key: literal-do-not-leak"));

		const result = await runAgents(["version", "enable", "--file", configPath, "--json"], testEnvironment);
		expect(result.exitCode).toBe(1);
		expect(`${result.stdout}${result.stderr}`).not.toContain("literal-do-not-leak");
		expect(result.stderr).toContain("environment variable reference");
		const status = await runAgents(["version", "status", "--file", configPath, "--json"], testEnvironment);
		expect(JSON.parse(status.stdout).initialized).toBe(false);
	});

	test("help exposes snapshot versions without Git or a manual create command", async () => {
		const result = await runAgents(["version", "--help"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("enable");
		expect(result.stdout).toContain("restore");
		expect(result.stdout).not.toContain("Git");
		expect(result.stdout).not.toMatch(/^\s+create\b/m);

		const versionHelp = await runAgents(["version", "status", "--help"]);
		expect(versionHelp.stdout).toContain("--file <path>");
		expect(versionHelp.stdout).not.toContain("-f, --file <path>");
	});
});

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "agents-cli-version-"));
	directories.push(directory);
	return directory;
}

function projectYaml(instructions: string): string {
	return `version: "1"
providers:
  qoder:
    api_key: \${QODER_PAT}
defaults:
  provider: qoder
agents:
  assistant:
    model: ultimate
    instructions: ${instructions}
`;
}

async function seedMatchingAgentState(root: string, configPath: string): Promise<void> {
	const plan = await runAgents(["plan", "--file", configPath, "--refresh", "false", "--json"], testEnvironment);
	if (plan.exitCode !== 0) throw new Error(plan.stderr);
	const action = JSON.parse(plan.stdout).actions.find(
		(candidate: { address: { name: string }; after?: { content_hash?: string } }) =>
			candidate.address.name === "assistant",
	);
	const contentHash = action?.after?.content_hash;
	if (!contentHash) throw new Error("Plan did not produce an Agent content hash.");
	await writeFile(
		join(root, "agents.state.json"),
		JSON.stringify({
			resources: [
				{
					address: { type: "agent", name: "assistant", provider: "qoder" },
					remote_id: "agent_test",
					content_hash: contentHash,
					desired_hash: contentHash,
				},
			],
		}),
	);
}

async function runAgents(args: string[], environment: Record<string, string> = {}) {
	const processHandle = Bun.spawn([process.execPath, "run", join(REPO_ROOT, "packages/cli/bin/agents.ts"), ...args], {
		cwd: REPO_ROOT,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", ...environment },
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(processHandle.stdout).text(),
		new Response(processHandle.stderr).text(),
		processHandle.exited,
	]);
	return { stdout, stderr, exitCode };
}
