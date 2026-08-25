import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { commitAutomaticVersion, prepareAutomaticVersion } from "../../src/versioning/local-git";

const execFileAsync = promisify(execFile);
const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const directories: string[] = [];
const gitIdentity = {
	GIT_AUTHOR_NAME: "CLI Version Test",
	GIT_AUTHOR_EMAIL: "cli-version@example.com",
	GIT_COMMITTER_NAME: "CLI Version Test",
	GIT_COMMITTER_EMAIL: "cli-version@example.com",
	QODER_PAT: "test-qoder-token",
};

afterEach(async () => {
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("agents version", () => {
	test("enable discovers the parent repository, creates one YAML-only baseline, and preserves the real index", async () => {
		const root = await temporaryDirectory();
		const projectDirectory = join(root, "project");
		await mkdir(projectDirectory);
		const configPath = join(projectDirectory, "agents.yaml");
		await writeFile(configPath, projectYaml("Baseline"));
		await git(root, ["init", "--initial-branch", "main"]);
		await writeFile(join(root, "staged.txt"), "staged\n");
		await git(root, ["add", "staged.txt"]);
		await writeFile(join(root, "unstaged.txt"), "unstaged\n");
		const otherStatus = await git(root, ["status", "--porcelain=v1", "--", "staged.txt", "unstaged.txt"]);

		const enabled = await runAgents(["version", "enable", "--file", configPath, "--json"], gitIdentity);
		expect(enabled.exitCode).toBe(0);
		const body = JSON.parse(enabled.stdout);
		expect(body.git.enabled).toBe(true);
		expect(body.git.branch).toBe("main");
		expect(body.version.message).toBe("Enable OpenAgentPack versioning");
		expect((await git(root, ["show", "--pretty=", "--name-only", "HEAD"])).trim()).toBe("project/agents.yaml");
		expect(await git(root, ["status", "--porcelain=v1", "--", "staged.txt", "unstaged.txt"])).toBe(otherStatus);

		const repeated = await runAgents(["version", "enable", "--file", configPath, "--json"], gitIdentity);
		expect(repeated.exitCode).toBe(0);
		expect(JSON.parse(repeated.stdout).version).toBeNull();
		expect((await git(root, ["rev-list", "--count", "HEAD"])).trim()).toBe("1");
	}, 20_000);

	test("enable initializes main, markers are path-scoped, and disable preserves history", async () => {
		const root = await temporaryDirectory();
		const firstPath = join(root, "agents.yaml");
		const secondDirectory = join(root, "nested");
		await mkdir(secondDirectory);
		const secondPath = join(secondDirectory, "agents.yaml");
		await writeFile(firstPath, projectYaml("First"));
		await writeFile(secondPath, projectYaml("Second"));

		const first = await runAgents(["version", "enable", "--file", firstPath, "--json"], gitIdentity);
		expect(first.exitCode).toBe(0);
		expect(JSON.parse(first.stdout).git.branch).toBe("main");
		const second = await runAgents(["version", "enable", "--file", secondPath, "--json"], gitIdentity);
		expect(second.exitCode).toBe(0);

		const disabled = await runAgents(["version", "disable", "--file", firstPath, "--json"], gitIdentity);
		expect(JSON.parse(disabled.stdout).enabled).toBe(false);
		const secondStatus = await runAgents(["version", "status", "--file", secondPath, "--json"], gitIdentity);
		expect(JSON.parse(secondStatus.stdout).enabled).toBe(true);
		expect((await git(root, ["rev-list", "--count", "HEAD"])).trim()).toBe("2");
	}, 20_000);

	test("automatic versioning opt-in is isolated between linked worktrees", async () => {
		const container = await temporaryDirectory();
		const root = join(container, "primary");
		const linked = join(container, "linked");
		await mkdir(root);
		const configPath = join(root, "agents.yaml");
		await writeFile(configPath, projectYaml("Primary"));
		await git(root, ["init", "--initial-branch", "main"]);

		const primaryEnabled = await runAgents(["version", "enable", "--file", configPath, "--json"], gitIdentity);
		expect(primaryEnabled.exitCode).toBe(0);
		await git(root, ["worktree", "add", "-b", "linked", linked, "HEAD"]);

		const linkedStatus = await runAgents(
			["version", "status", "--file", join(linked, "agents.yaml"), "--json"],
			gitIdentity,
		);
		expect(linkedStatus.exitCode).toBe(0);
		expect(JSON.parse(linkedStatus.stdout).enabled).toBe(false);

		const linkedEnabled = await runAgents(
			["version", "enable", "--file", join(linked, "agents.yaml"), "--json"],
			gitIdentity,
		);
		expect(linkedEnabled.exitCode).toBe(0);
		expect(JSON.parse(linkedEnabled.stdout).git.enabled).toBe(true);
		await runAgents(["version", "disable", "--file", configPath, "--json"], gitIdentity);

		const primaryStatus = await runAgents(["version", "status", "--file", configPath, "--json"], gitIdentity);
		const stillEnabledLinkedStatus = await runAgents(
			["version", "status", "--file", join(linked, "agents.yaml"), "--json"],
			gitIdentity,
		);
		expect(JSON.parse(primaryStatus.stdout).enabled).toBe(false);
		expect(JSON.parse(stillEnabledLinkedStatus.stdout).enabled).toBe(true);
	}, 30_000);

	test("list, preview, and restore use full reachable SHAs without moving HEAD or State", async () => {
		const root = await temporaryDirectory();
		const configPath = join(root, "agents.yaml");
		const statePath = join(root, "agents.state.json");
		await writeFile(configPath, projectYaml("Version one"));
		await chmod(configPath, 0o640);
		await writeFile(statePath, '{"remote":"latest"}\n');
		const enabled = await runAgents(["version", "enable", "--file", configPath, "--json"], gitIdentity);
		const firstCommit = JSON.parse(enabled.stdout).version.commit as string;

		const secondSource = projectYaml("Version two");
		await writeFile(configPath, secondSource, { mode: 0o640 });
		const prepared = await withGitIdentity(() => prepareAutomaticVersion(configPath, secondSource));
		const secondVersion = await withGitIdentity(() => commitAutomaticVersion(prepared!));
		expect(secondVersion?.message).toBe("Apply agents.yaml");

		const listed = await runAgents(["version", "list", "--file", configPath, "--json"], gitIdentity);
		expect(JSON.parse(listed.stdout).versions.map((version: { message: string }) => version.message)).toEqual([
			"Apply agents.yaml",
			"Enable OpenAgentPack versioning",
		]);
		const abbreviated = await runAgents(
			["version", "preview", firstCommit.slice(0, 12), "--file", configPath],
			gitIdentity,
		);
		expect(abbreviated.exitCode).toBe(1);
		expect(abbreviated.stderr).toContain("full hexadecimal commit SHA");

		const preview = await runAgents(["version", "preview", firstCommit, "--file", configPath], gitIdentity);
		expect(preview.exitCode).toBe(0);
		expect(preview.stdout).toContain("-    instructions: Version two");
		expect(preview.stdout).toContain("+    instructions: Version one");
		const headBeforeRestore = (await git(root, ["rev-parse", "HEAD"])).trim();
		const restored = await runAgents(
			["version", "restore", firstCommit, "--file", configPath, "--yes", "--json"],
			gitIdentity,
		);
		expect(restored.exitCode).toBe(0);
		expect(await readFile(configPath, "utf8")).toContain("Version one");
		expect((await git(root, ["rev-parse", "HEAD"])).trim()).toBe(headBeforeRestore);
		expect(await readFile(statePath, "utf8")).toBe('{"remote":"latest"}\n');
		expect((await stat(configPath)).mode & 0o777).toBe(0o640);
	}, 20_000);

	test("successful no-op Apply commits dirty YAML only when versioning is enabled", async () => {
		const root = await temporaryDirectory();
		const configPath = join(root, "agents.yaml");
		await writeFile(configPath, projectYaml("Initial"));
		await runAgents(["version", "enable", "--file", configPath, "--json"], gitIdentity);
		const baselineHead = (await git(root, ["rev-parse", "HEAD"])).trim();

		await writeFile(configPath, projectYaml("Applied change"));
		const refreshOnly = await runAgents(
			["apply", "--file", configPath, "--refresh", "false", "--refresh-only", "--yes"],
			gitIdentity,
		);
		expect(refreshOnly.exitCode).toBe(0);
		expect((await git(root, ["rev-parse", "HEAD"])).trim()).toBe(baselineHead);
		await seedMatchingAgentState(root, configPath);
		const applied = await runAgents(["apply", "--file", configPath, "--refresh", "false", "--yes"], gitIdentity);
		expect(applied.exitCode).toBe(0);
		expect(applied.stderr).toContain("Created local version");
		expect((await git(root, ["log", "-1", "--format=%s"])).trim()).toBe("Apply agents.yaml");

		await runAgents(["version", "disable", "--file", configPath, "--json"], gitIdentity);
		const headBeforeDisabledApply = (await git(root, ["rev-parse", "HEAD"])).trim();
		await writeFile(configPath, projectYaml("Disabled change"));
		await seedMatchingAgentState(root, configPath);
		const disabledApply = await runAgents(["apply", "--file", configPath, "--refresh", "false", "--yes"], gitIdentity);
		expect(disabledApply.exitCode).toBe(0);
		expect((await git(root, ["rev-parse", "HEAD"])).trim()).toBe(headBeforeDisabledApply);
	}, 30_000);

	test("an Apply-time YAML race rejects the commit with remote-state recovery guidance", async () => {
		const root = await temporaryDirectory();
		const configPath = join(root, "agents.yaml");
		await writeFile(configPath, projectYaml("Initial"));
		await runAgents(["version", "enable", "--file", configPath, "--json"], gitIdentity);
		const expectedSource = projectYaml("Expected");
		await writeFile(configPath, expectedSource);
		const prepared = await withGitIdentity(() => prepareAutomaticVersion(configPath, expectedSource));
		await writeFile(configPath, projectYaml("Concurrent edit"));

		await expect(withGitIdentity(() => commitAutomaticVersion(prepared!))).rejects.toThrow(
			"Remote Apply completed, but agents.yaml could not be versioned",
		);
		expect((await git(root, ["rev-list", "--count", "HEAD"])).trim()).toBe("1");
	}, 20_000);

	test("a failed remote Apply leaves dirty YAML uncommitted", async () => {
		const root = await temporaryDirectory();
		const configPath = join(root, "agents.yaml");
		const initialSource = withUnavailableGateway(projectYaml("Initial"));
		await writeFile(configPath, initialSource);
		await runAgents(["version", "enable", "--file", configPath, "--json"], gitIdentity);
		const baselineHead = (await git(root, ["rev-parse", "HEAD"])).trim();
		await writeFile(configPath, withUnavailableGateway(projectYaml("Remote failure")));

		const applied = await runAgents(["apply", "--file", configPath, "--refresh", "false", "--yes"], gitIdentity);
		expect(applied.exitCode).toBe(1);
		expect((await git(root, ["rev-parse", "HEAD"])).trim()).toBe(baselineHead);
		expect(await git(root, ["status", "--porcelain=v1", "--", "agents.yaml"])).toContain(" M agents.yaml");
	}, 20_000);

	test("sensitive literals block enable without leaking the value or enabling the marker", async () => {
		const root = await temporaryDirectory();
		const configPath = join(root, "agents.yaml");
		const qoderReference = ["api_key: $", "{QODER_PAT}"].join("");
		await writeFile(configPath, projectYaml("Unsafe").replace(qoderReference, "api_key: literal-do-not-leak"));

		const result = await runAgents(["version", "enable", "--file", configPath, "--json"], gitIdentity);
		expect(result.exitCode).toBe(1);
		expect(`${result.stdout}${result.stderr}`).not.toContain("literal-do-not-leak");
		expect(result.stderr).toContain("environment variable reference");
		const status = await runAgents(["version", "status", "--file", configPath, "--json"], gitIdentity);
		expect(JSON.parse(status.stdout).enabled).toBe(false);
	}, 20_000);

	test("help exposes no manual create command", async () => {
		const result = await runAgents(["version", "--help"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("enable");
		expect(result.stdout).toContain("restore");
		expect(result.stdout).not.toMatch(/^\s+create\b/m);
	});

	test("version commands expose --file without a command-level -f alias", async () => {
		const versionHelp = await runAgents(["version", "status", "--help"]);
		expect(versionHelp.exitCode).toBe(0);
		expect(versionHelp.stdout).toContain("--file <path>");
		expect(versionHelp.stdout).not.toContain("-f, --file <path>");

		const existingCommandHelp = await runAgents(["validate", "--help"]);
		expect(existingCommandHelp.exitCode).toBe(0);
		expect(existingCommandHelp.stdout).toContain("-f, --file <path>");
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

function withUnavailableGateway(source: string): string {
	return source.replace("defaults:", '    gateway: "http://127.0.0.1:1"\ndefaults:');
}

async function seedMatchingAgentState(root: string, configPath: string): Promise<void> {
	const plan = await runAgents(["plan", "--file", configPath, "--refresh", "false", "--json"], gitIdentity);
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

async function git(cwd: string, args: string[]): Promise<string> {
	const result = await execFileAsync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...gitIdentity } });
	return result.stdout;
}

async function withGitIdentity<Result>(operation: () => Promise<Result>): Promise<Result> {
	const previous = Object.fromEntries(Object.keys(gitIdentity).map((key) => [key, process.env[key]]));
	Object.assign(process.env, gitIdentity);
	try {
		return await operation();
	} finally {
		for (const key of Object.keys(gitIdentity)) {
			const value = previous[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}
