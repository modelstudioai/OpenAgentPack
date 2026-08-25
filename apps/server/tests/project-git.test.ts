import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	createProjectVersion,
	ensureProjectVersionForApply,
	getProjectGitStatus,
	initializeProjectGit,
	listProjectVersions,
	previewProjectVersion,
	restoreProjectVersion,
	setProjectVersioning,
} from "../src/services/project-git";
import { ProjectRuntimeManager } from "../src/services/project-manager";

const execFileAsync = promisify(execFile);
const directories: string[] = [];
const managers: ProjectRuntimeManager[] = [];

afterEach(async () => {
	for (const manager of managers.splice(0)) manager.close();
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("Workbench local Git versions", () => {
	test("discovers a parent repository and commits only agents.yaml without disturbing the real index", async () => {
		const fixture = await gitFixture();
		await writeFile(join(fixture.root, "staged.txt"), "staged\n");
		await git(fixture.root, ["add", "staged.txt"]);
		await writeFile(join(fixture.root, "unstaged.txt"), "unstaged\n");
		const beforeOtherStatus = await otherFileStatus(fixture.root);

		const status = await getProjectGitStatus(fixture.manager);
		expect(status.repository_root).toBe(await realpath(fixture.root));
		expect(status.config_path).toBe("project/agents.yaml");
		expect(status.head).toBeNull();
		expect(status.config_status).toBe("untracked");

		const created = await createProjectVersion(
			{
				baseRevision: fixture.manager.getSnapshot().revision!,
				baseHead: null,
				message: "Initial Agent configuration",
			},
			fixture.manager,
		);

		expect(created.version.message).toBe("Initial Agent configuration");
		expect(created.git.config_versioned).toBe(true);
		expect(await otherFileStatus(fixture.root)).toBe(beforeOtherStatus);
		expect((await git(fixture.root, ["show", "--pretty=", "--name-only", "HEAD"])).trim()).toBe("project/agents.yaml");
	}, 20_000);

	test("creates path-filtered history and restores old YAML without moving HEAD or State", async () => {
		const fixture = await gitFixture();
		await chmod(fixture.configPath, 0o640);
		const statePath = join(fixture.projectDirectory, "agents.state.json");
		await writeFile(statePath, '{"remote":"latest"}\n');
		const first = await createProjectVersion(
			{
				baseRevision: fixture.manager.getSnapshot().revision!,
				baseHead: null,
				message: "Version one",
			},
			fixture.manager,
		);
		await writeFile(fixture.configPath, projectYaml("Second instructions"));
		await fixture.manager.refreshAfterSourceMutation();
		const second = await createProjectVersion(
			{
				baseRevision: fixture.manager.getSnapshot().revision!,
				baseHead: first.version.commit,
				message: "Version two",
			},
			fixture.manager,
		);
		await writeFile(join(fixture.root, "unrelated.txt"), "unrelated\n");
		await git(fixture.root, ["add", "unrelated.txt"]);
		await git(fixture.root, ["commit", "-m", "Unrelated commit"]);

		const page = await listProjectVersions({}, fixture.manager);
		expect(page.versions.map((version) => version.message)).toEqual(["Version two", "Version one"]);
		const headBeforeRestore = (await git(fixture.root, ["rev-parse", "HEAD"])).trim();
		const revision = fixture.manager.getSnapshot().revision!;
		const preview = await previewProjectVersion(
			{ commit: first.version.commit, baseRevision: revision, baseHead: headBeforeRestore },
			fixture.manager,
		);
		expect(preview.can_restore).toBe(true);
		expect(preview.before_yaml).toContain("Second instructions");
		expect(preview.after_yaml).toContain("First instructions");

		const restored = await restoreProjectVersion(
			{ commit: first.version.commit, baseRevision: revision, baseHead: headBeforeRestore },
			fixture.manager,
		);
		expect(restored.new_revision).not.toBe(revision);
		expect(await readFile(fixture.configPath, "utf8")).toContain("First instructions");
		expect((await git(fixture.root, ["rev-parse", "HEAD"])).trim()).toBe(headBeforeRestore);
		expect(await readFile(statePath, "utf8")).toBe('{"remote":"latest"}\n');
		expect((await stat(fixture.configPath)).mode & 0o777).toBe(0o640);
		expect(second.version.commit).not.toBe(first.version.commit);
	}, 20_000);

	test("restores a valid version when the current agents.yaml is syntactically invalid", async () => {
		const fixture = await gitFixture();
		const created = await createProjectVersion(
			{
				baseRevision: fixture.manager.getSnapshot().revision!,
				baseHead: null,
				message: "Recoverable version",
			},
			fixture.manager,
		);
		await writeFile(fixture.configPath, "version: [\napi_key: literal-do-not-leak\n");
		await fixture.manager.refreshAfterSourceMutation();
		const invalidRevision = fixture.manager.getSnapshot().revision!;

		expect(fixture.manager.getSnapshot().status).toBe("invalid");
		const restored = await restoreProjectVersion(
			{ commit: created.version.commit, baseRevision: invalidRevision, baseHead: created.version.commit },
			fixture.manager,
		);

		expect(restored.new_revision).not.toBe(invalidRevision);
		expect(fixture.manager.getSnapshot().status).toBe("valid");
		expect(JSON.stringify(restored)).not.toContain("literal-do-not-leak");
	}, 20_000);

	test("explicitly initializes main only when no parent repository exists", async () => {
		const directory = await mkdtemp(join(tmpdir(), "openagentpack-git-init-"));
		directories.push(directory);
		const configPath = join(directory, "agents.yaml");
		await writeFile(configPath, projectYaml("Instructions"));
		const manager = new ProjectRuntimeManager(configPath);
		managers.push(manager);
		await manager.ensureStarted();

		expect((await getProjectGitStatus(manager)).repository_root).toBeNull();
		const initialized = await withGitIdentity(() =>
			initializeProjectGit({ baseRevision: manager.getSnapshot().revision! }, manager),
		);
		expect(initialized.repository_root).toBe(await realpath(directory));
		expect(initialized.branch).toBe("main");
		expect(initialized.head).not.toBeNull();
		expect(initialized.config_versioned).toBe(true);
		expect((await listProjectVersions({}, manager)).versions[0]?.message).toBe("Initialize agents.yaml");
	}, 20_000);

	test("shares one enable switch with CLI consumers and does not re-enable it implicitly", async () => {
		const fixture = await gitFixture();
		const revision = fixture.manager.getSnapshot().revision!;
		const enabled = await setProjectVersioning({ baseRevision: revision, enabled: true }, fixture.manager);
		expect(enabled.enabled).toBe(true);
		const disabled = await setProjectVersioning({ baseRevision: revision, enabled: false }, fixture.manager);
		expect(disabled.enabled).toBe(false);
		expect((await getProjectGitStatus(fixture.manager)).enabled).toBe(false);
	}, 20_000);

	test("automatically initializes and versions dirty YAML before Apply without creating empty commits", async () => {
		const directory = await mkdtemp(join(tmpdir(), "openagentpack-git-auto-apply-"));
		directories.push(directory);
		const configPath = join(directory, "agents.yaml");
		await writeFile(configPath, projectYaml("Initial instructions"));
		const manager = new ProjectRuntimeManager(configPath);
		managers.push(manager);
		await manager.ensureStarted();

		const first = await withGitIdentity(() =>
			ensureProjectVersionForApply(
				{ baseRevision: manager.getSnapshot().revision!, message: "Apply project revision initial" },
				manager,
			),
		);
		expect(first.version?.message).toBe("Apply project revision initial");
		expect(first.git.branch).toBe("main");
		expect(first.git.config_versioned).toBe(true);

		const reused = await withGitIdentity(() =>
			ensureProjectVersionForApply(
				{ baseRevision: manager.getSnapshot().revision!, message: "Apply project revision unchanged" },
				manager,
			),
		);
		expect(reused.version).toBeNull();
		expect(reused.git.head).toBe(first.git.head);

		await writeFile(configPath, projectYaml("Changed instructions"));
		await manager.refreshAfterSourceMutation();
		const changed = await withGitIdentity(() =>
			ensureProjectVersionForApply(
				{ baseRevision: manager.getSnapshot().revision!, message: "Apply project revision changed" },
				manager,
			),
		);
		expect(changed.version?.commit).not.toBe(first.git.head);
		expect((await listProjectVersions({}, manager)).versions.map((version) => version.message)).toEqual([
			"Apply project revision changed",
			"Apply project revision initial",
		]);
	}, 20_000);

	test("reports missing identity, in-progress Git operations, and detached HEAD as write blockers", async () => {
		const fixture = await gitFixture();
		const created = await createProjectVersion(
			{
				baseRevision: fixture.manager.getSnapshot().revision!,
				baseHead: null,
				message: "Initial version",
			},
			fixture.manager,
		);

		await git(fixture.root, ["config", "user.name", ""]);
		let status = await getProjectGitStatus(fixture.manager);
		expect(status.commit_blockers.join(" ")).toContain("user.name");
		await git(fixture.root, ["config", "user.name", "Workbench Test"]);

		const gitDirectory = (await git(fixture.root, ["rev-parse", "--git-dir"])).trim();
		await writeFile(join(fixture.root, gitDirectory, "MERGE_HEAD"), `${created.version.commit}\n`);
		status = await getProjectGitStatus(fixture.manager);
		expect(status.commit_blockers.join(" ")).toContain("merge head");
		await rm(join(fixture.root, gitDirectory, "MERGE_HEAD"));

		await git(fixture.root, ["checkout", "--detach", created.version.commit]);
		status = await getProjectGitStatus(fixture.manager);
		expect(status.branch).toBeNull();
		expect(status.restore_blockers.join(" ")).toContain("Detached HEAD");
	}, 20_000);

	test("rejects sensitive literals, stale revisions, stale HEAD, staged config, and abbreviated SHAs", async () => {
		const fixture = await gitFixture();
		await writeFile(
			fixture.configPath,
			projectYaml("Instructions").replace("qoder: {}", "qoder:\n    api_key: literal-secret"),
		);
		await fixture.manager.refreshAfterSourceMutation();
		await expect(
			createProjectVersion(
				{
					baseRevision: fixture.manager.getSnapshot().revision!,
					baseHead: null,
					message: "Unsafe",
				},
				fixture.manager,
			),
		).rejects.toMatchObject({ status: 422 });

		await writeFile(fixture.configPath, projectYaml("Safe"));
		await fixture.manager.refreshAfterSourceMutation();
		const revision = fixture.manager.getSnapshot().revision!;
		await expect(
			createProjectVersion({ baseRevision: "stale", baseHead: null, message: "Stale" }, fixture.manager),
		).rejects.toMatchObject({ status: 409 });
		const created = await createProjectVersion(
			{ baseRevision: revision, baseHead: null, message: "Safe version" },
			fixture.manager,
		);
		await writeFile(fixture.configPath, projectYaml("Changed"));
		await fixture.manager.refreshAfterSourceMutation();
		await git(fixture.root, ["add", "project/agents.yaml"]);
		await expect(
			createProjectVersion(
				{
					baseRevision: fixture.manager.getSnapshot().revision!,
					baseHead: created.version.commit,
					message: "Staged",
				},
				fixture.manager,
			),
		).rejects.toMatchObject({ status: 409 });
		await expect(
			previewProjectVersion(
				{
					commit: created.version.commit.slice(0, 12),
					baseRevision: fixture.manager.getSnapshot().revision!,
					baseHead: created.version.commit,
				},
				fixture.manager,
			),
		).rejects.toMatchObject({ status: 400 });
	}, 20_000);
});

async function gitFixture(): Promise<{
	root: string;
	projectDirectory: string;
	configPath: string;
	manager: ProjectRuntimeManager;
}> {
	const root = await mkdtemp(join(tmpdir(), "openagentpack-git-"));
	directories.push(root);
	const projectDirectory = join(root, "project");
	await mkdir(projectDirectory);
	const configPath = join(projectDirectory, "agents.yaml");
	await writeFile(configPath, projectYaml("First instructions"));
	await git(root, ["init", "--initial-branch", "main"]);
	await git(root, ["config", "user.name", "Workbench Test"]);
	await git(root, ["config", "user.email", "workbench@example.com"]);
	const manager = new ProjectRuntimeManager(configPath);
	managers.push(manager);
	await manager.ensureStarted();
	if (manager.getSnapshot().status !== "valid") throw new Error(JSON.stringify(manager.getSnapshot().diagnostics));
	return { root, projectDirectory, configPath, manager };
}

function projectYaml(instructions: string): string {
	return `version: "1"
providers:
  qoder: {}
defaults:
  provider: qoder
agents:
  assistant:
    model: ultimate
    instructions: ${instructions}
`;
}

async function git(cwd: string, args: string[]): Promise<string> {
	const result = await execFileAsync("git", args, { cwd, encoding: "utf8" });
	return result.stdout;
}

async function otherFileStatus(root: string): Promise<string> {
	return git(root, ["status", "--porcelain=v1", "--", "staged.txt", "unstaged.txt"]);
}

async function withGitIdentity<Result>(operation: () => Promise<Result>): Promise<Result> {
	const keys = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"] as const;
	const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
	process.env.GIT_AUTHOR_NAME = "Workbench Test";
	process.env.GIT_AUTHOR_EMAIL = "workbench@example.com";
	process.env.GIT_COMMITTER_NAME = "Workbench Test";
	process.env.GIT_COMMITTER_EMAIL = "workbench@example.com";
	try {
		return await operation();
	} finally {
		for (const key of keys) {
			const value = previous[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}
