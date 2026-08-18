import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { createGitProject } from "../../src/commands/init.ts";

const tempDirectories: string[] = [];

async function makeTempDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "openagentpack-init-"));
	tempDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	while (tempDirectories.length > 0) {
		const directory = tempDirectories.pop()!;
		await rm(directory, { recursive: true, force: true });
	}
});

test("creates an Aone-ready project with main-branch state deployment", async () => {
	const parentDirectory = await makeTempDirectory();
	const projectDirectory = join(parentDirectory, "daily-reporter");

	await createGitProject(projectDirectory, {
		provider: "bailian",
		agentName: "reporter",
		cliVersion: "0.3.2",
		initializeGit: false,
	});

	const config = await readFile(join(projectDirectory, "agents.yaml"), "utf8");
	expect(config).toContain(`api_key: \${DASHSCOPE_API_KEY}`);
	expect(config).toContain(`base_url: \${BAILIAN_BASE_URL}`);
	expect(config).toContain("instructions: ./instructions/reporter.md");
	expect(await readFile(join(projectDirectory, "instructions/reporter.md"), "utf8")).toBe(
		"You are a helpful assistant.\n",
	);
	const environmentExample = await readFile(join(projectDirectory, ".env.example"), "utf8");
	expect(environmentExample).toContain("BAILIAN_BASE_URL=replace-me");
	expect(environmentExample).not.toContain("BAILIAN_WORKSPACE_ID");
	const gitignore = await readFile(join(projectDirectory, ".gitignore"), "utf8");
	expect(gitignore).toContain(".openagentpack/state/");
	expect(gitignore).not.toContain("agents.state.json");
	expect(JSON.parse(await readFile(join(projectDirectory, "agents.state.json"), "utf8"))).toEqual({ resources: [] });

	const packageJson = JSON.parse(await readFile(join(projectDirectory, "package.json"), "utf8")) as {
		name: string;
		scripts: Record<string, string>;
		devDependencies: Record<string, string>;
	};
	expect(packageJson.name).toBe("daily-reporter");
	expect(packageJson.scripts["agents:plan:ci"]).toBe("agents plan -f agents.yaml --json");
	expect(packageJson.scripts["agents:apply:ci"]).toBe("agents apply -f agents.yaml --ci");
	expect(packageJson.devDependencies["@openagentpack/cli"]).toBe("0.3.2");

	const workflow = await readFile(join(projectDirectory, ".aoneci/openagentpack.yml"), "utf8");
	const parsedWorkflow = parseYaml(workflow) as { triggers: { push: { branches: string[] } } };
	expect(parsedWorkflow.triggers.push.branches).toEqual(["main"]);
	expect(workflow).toContain("triggers:\n  push:\n    branches:\n      - main");
	expect(workflow).toContain("npm run agents:plan:ci > openagentpack-plan.json");
	expect(workflow).toContain(`DASHSCOPE_API_KEY: \${{secrets.DASHSCOPE_API_KEY}}`);
	expect(workflow).toContain("npm run agents:apply:ci");
	expect(workflow).toContain("git push origin HEAD:main");
	const checkWorkflow = await readFile(join(projectDirectory, ".aoneci/openagentpack-check.yml"), "utf8");
	expect(() => parseYaml(checkWorkflow)).not.toThrow();
	expect(checkWorkflow).toContain("Bind this pipeline to Codeup merge-request new/update events");
	expect(checkWorkflow).toContain("npm run agents:plan:ci > openagentpack-plan.json");
	expect(checkWorkflow).not.toContain("agents:apply:ci");
});

test("upgrades an existing agents.yaml project without replacing user content", async () => {
	const projectDirectory = await makeTempDirectory();
	const config = `version: "1"

providers:
  bailian:
    api_key: \${DASHSCOPE_API_KEY}
    workspace_id: \${BAILIAN_WORKSPACE_ID}

agents:
  existing:
    model: qwen3.7-max
    instructions: "Keep this configuration."
`;
	const readme = "# Existing project\n\nKeep this README.\n";
	const workflow = "name: Custom workflow\n";
	await writeFile(join(projectDirectory, "agents.yaml"), config, "utf8");
	await writeFile(join(projectDirectory, ".gitignore"), "agents.state.json\n.env\n", "utf8");
	await writeFile(join(projectDirectory, ".env.example"), "DASHSCOPE_API_KEY=keep-me\n", "utf8");
	await writeFile(
		join(projectDirectory, "package.json"),
		`${JSON.stringify(
			{
				name: "existing-project",
				devDependencies: {
					"@openagentpack/cli": "0.3.2",
				},
				scripts: {
					test: "custom-test",
					"agents:plan:ci": "agents plan -f agents.yaml --refresh false --json",
					"agents:apply:ci": "agents apply -f agents.yaml --yes",
				},
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
	await writeFile(join(projectDirectory, "README.md"), readme, "utf8");
	await mkdir(join(projectDirectory, ".aoneci"), { recursive: true });
	await writeFile(join(projectDirectory, ".aoneci/openagentpack.yml"), workflow, "utf8");

	const result = await createGitProject(projectDirectory, {
		cliVersion: "0.4.0",
		initializeGit: false,
	});

	expect(result.mode).toBe("upgraded");
	expect(result.initializedGit).toBe(false);
	expect(result.preservedFiles).toContain("agents.yaml");
	expect(result.preservedFiles).toContain("README.md");
	expect(result.preservedFiles).toContain(".aoneci/openagentpack.yml");
	expect(await readFile(join(projectDirectory, "agents.yaml"), "utf8")).toBe(config);
	expect(await readFile(join(projectDirectory, "README.md"), "utf8")).toBe(readme);
	expect(await readFile(join(projectDirectory, ".aoneci/openagentpack.yml"), "utf8")).toBe(workflow);
	expect(await readFile(join(projectDirectory, ".aoneci/openagentpack-check.yml"), "utf8")).toContain(
		"OpenAgentPack Check",
	);
	expect(JSON.parse(await readFile(join(projectDirectory, "agents.state.json"), "utf8"))).toEqual({ resources: [] });

	const environment = await readFile(join(projectDirectory, ".env.example"), "utf8");
	expect(environment).toContain("DASHSCOPE_API_KEY=keep-me");
	expect(environment).toContain("BAILIAN_WORKSPACE_ID=replace-me");
	const gitignore = await readFile(join(projectDirectory, ".gitignore"), "utf8");
	expect(gitignore).not.toContain("agents.state.json");
	expect(gitignore).toContain(".openagentpack/state/");
	expect(gitignore).toContain("!.env.example");

	const packageJson = JSON.parse(await readFile(join(projectDirectory, "package.json"), "utf8")) as {
		private: boolean;
		scripts: Record<string, string>;
		devDependencies: Record<string, string>;
	};
	expect(packageJson.private).toBe(true);
	expect(packageJson.scripts.test).toBe("custom-test");
	expect(packageJson.scripts["agents:validate"]).toBe("agents validate -f agents.yaml");
	expect(packageJson.scripts["agents:plan:ci"]).toBe("agents plan -f agents.yaml --json");
	expect(packageJson.scripts["agents:apply:ci"]).toBe("agents apply -f agents.yaml --ci");
	expect(packageJson.devDependencies["@openagentpack/cli"]).toBe("0.4.0");
});

test("quotes Agent names that are not safe plain YAML mapping keys", async () => {
	const parentDirectory = await makeTempDirectory();
	const projectDirectory = join(parentDirectory, "yaml-key-agent");

	await createGitProject(projectDirectory, {
		provider: "claude",
		agentName: "daily: reporter",
		cliVersion: "0.3.2",
		initializeGit: false,
	});

	const config = await readFile(join(projectDirectory, "agents.yaml"), "utf8");
	const parsed = parseYaml(config) as { agents: Record<string, { instructions: string }> };
	expect(Object.keys(parsed.agents)).toEqual(["daily: reporter"]);
	expect(parsed.agents["daily: reporter"]?.instructions).toBe("./instructions/daily-reporter.md");
});

test("preserves an existing Git repository when upgrading", async () => {
	const projectDirectory = await makeTempDirectory();
	await writeFile(join(projectDirectory, "agents.yaml"), 'version: "1"\n', "utf8");
	await mkdir(join(projectDirectory, ".git"));
	await writeFile(join(projectDirectory, ".git/keep"), "keep\n", "utf8");

	const result = await createGitProject(projectDirectory, {
		cliVersion: "0.3.2",
	});

	expect(result.mode).toBe("upgraded");
	expect(result.initializedGit).toBe(false);
	expect(await readFile(join(projectDirectory, ".git/keep"), "utf8")).toBe("keep\n");
});

test("initializes a local Git repository on the main branch", async () => {
	const parentDirectory = await makeTempDirectory();
	const projectDirectory = join(parentDirectory, "preview-agent");

	await createGitProject(projectDirectory, {
		provider: "qoder",
		agentName: "assistant",
		cliVersion: "0.3.2",
	});

	const workTree = Bun.spawnSync(["git", "rev-parse", "--is-inside-work-tree"], {
		cwd: projectDirectory,
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(workTree.exitCode).toBe(0);
	expect(workTree.stdout.toString().trim()).toBe("true");

	const branch = Bun.spawnSync(["git", "symbolic-ref", "--short", "HEAD"], {
		cwd: projectDirectory,
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(branch.exitCode).toBe(0);
	expect(branch.stdout.toString().trim()).toBe("main");

	const remotes = Bun.spawnSync(["git", "remote"], {
		cwd: projectDirectory,
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(remotes.exitCode).toBe(0);
	expect(remotes.stdout.toString().trim()).toBe("");

	const head = Bun.spawnSync(["git", "rev-parse", "--verify", "HEAD"], {
		cwd: projectDirectory,
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(head.exitCode).not.toBe(0);
});

test("refuses to overwrite a non-empty target directory", async () => {
	const parentDirectory = await makeTempDirectory();
	const projectDirectory = join(parentDirectory, "existing-project");
	await mkdir(projectDirectory);
	await writeFile(join(projectDirectory, "keep.txt"), "keep me\n", "utf8");

	expect(
		createGitProject(projectDirectory, {
			provider: "claude",
			agentName: "assistant",
			cliVersion: "0.3.2",
			initializeGit: false,
		}),
	).rejects.toThrow("is not empty");
	expect(await readFile(join(projectDirectory, "keep.txt"), "utf8")).toBe("keep me\n");
});
