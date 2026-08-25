import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	commitAutomaticVersion,
	createLocalGitVersionService,
	enableLocalVersioning,
	getLocalVersionStatus,
	prepareAutomaticVersion,
	previewLocalVersion,
	restoreLocalVersion,
} from "../src/index";

const execFileAsync = promisify(execFile);
const directories: string[] = [];
const gitEnvironment = {
	GIT_AUTHOR_NAME: "Local Git Test",
	GIT_AUTHOR_EMAIL: "local-git@example.com",
	GIT_COMMITTER_NAME: "Local Git Test",
	GIT_COMMITTER_EMAIL: "local-git@example.com",
};

afterEach(async () => {
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("shared local Git versions", () => {
	test("initializes main without creating a baseline or enabling automatic versions", async () => {
		const root = await temporaryDirectory();
		const configPath = join(root, "agents.yaml");
		await writeFile(configPath, projectYaml("Initial"));
		const service = createLocalGitVersionService({ configPath });

		const status = await service.initialize();

		expect(status.repository_root).toBe(await realpath(root));
		expect(status.branch).toBe("main");
		expect(status.head).toBeNull();
		expect(status.enabled).toBe(false);
	}, 20_000);

	test("uses one path-scoped switch and commits only agents.yaml", async () => {
		const root = await temporaryDirectory();
		const firstPath = join(root, "agents.yaml");
		const nestedDirectory = join(root, "nested");
		const secondPath = join(nestedDirectory, "agents.yaml");
		await mkdir(nestedDirectory);
		await writeFile(firstPath, projectYaml("First"));
		await writeFile(secondPath, projectYaml("Second"));
		await git(root, ["init", "--initial-branch", "main"]);
		await writeFile(join(root, "staged.txt"), "staged\n");
		await git(root, ["add", "staged.txt"]);
		const stagedBefore = await git(root, ["status", "--porcelain=v1", "--", "staged.txt"]);

		const first = await withGitEnvironment(() => enableLocalVersioning(firstPath, "Initial shared version"));
		expect(first.git.enabled).toBe(true);
		expect((await getLocalVersionStatus(secondPath)).enabled).toBe(false);
		expect((await git(root, ["show", "--pretty=", "--name-only", "HEAD"])).trim()).toBe("agents.yaml");
		expect(await git(root, ["status", "--porcelain=v1", "--", "staged.txt"])).toBe(stagedBefore);

		await writeFile(firstPath, projectYaml("First updated"));
		const repeated = await withGitEnvironment(() => enableLocalVersioning(firstPath, "Refresh shared baseline"));
		expect(repeated.version?.message).toBe("Refresh shared baseline");
		expect(await git(root, ["status", "--porcelain=v1", "--", "staged.txt"])).toBe(stagedBefore);
	}, 20_000);

	test("previews and restores a full reachable version without moving HEAD or changing permissions", async () => {
		const root = await temporaryDirectory();
		const configPath = join(root, "agents.yaml");
		await writeFile(configPath, projectYaml("Version one"));
		await chmod(configPath, 0o640);
		const enabled = await withGitEnvironment(() => enableLocalVersioning(configPath, "Version one"));
		const firstCommit = enabled.version!.commit;
		const secondSource = projectYaml("Version two");
		await writeFile(configPath, secondSource);
		const prepared = await withGitEnvironment(() => prepareAutomaticVersion(configPath, secondSource));
		await withGitEnvironment(() => commitAutomaticVersion(prepared!, "Version two"));
		const headBefore = (await git(root, ["rev-parse", "HEAD"])).trim();
		const preview = await previewLocalVersion(configPath, firstCommit);
		expect(preview.can_restore).toBe(true);
		expect(preview.after_yaml).toContain("Version one");
		await restoreLocalVersion(configPath, firstCommit, {
			head: preview.base_head,
			sourceRevision: preview.base_source_revision,
		});
		expect(await readFile(configPath, "utf8")).toContain("Version one");
		expect((await git(root, ["rev-parse", "HEAD"])).trim()).toBe(headBefore);
		expect((await stat(configPath)).mode & 0o777).toBe(0o640);
	}, 20_000);
});

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "openagentpack-local-git-"));
	directories.push(directory);
	return directory;
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

async function git(cwd: string, arguments_: string[]): Promise<string> {
	const result = await execFileAsync("git", arguments_, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, ...gitEnvironment },
	});
	return result.stdout;
}

async function withGitEnvironment<Result>(operation: () => Promise<Result>): Promise<Result> {
	const previous = Object.fromEntries(Object.keys(gitEnvironment).map((key) => [key, process.env[key]]));
	Object.assign(process.env, gitEnvironment);
	try {
		return await operation();
	} finally {
		for (const key of Object.keys(gitEnvironment)) {
			const value = previous[key];
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}
