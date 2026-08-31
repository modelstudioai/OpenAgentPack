import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
	acquireDirectoryProjectMutation,
	commitProjectBuild,
	createDirectoryWorkspaceVersionService,
	getProjectBuildStatus,
	initializeDirectoryProject,
	previewProjectBuild,
} from "../src/index.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryProject(): Promise<string> {
	const directory = await mkdtemp(resolve(tmpdir(), "openagentpack-directory-project-"));
	temporaryDirectories.push(directory);
	return directory;
}

describe("directory project build", () => {
	test("initializes a baseline and creates a revision-bound build", async () => {
		const root = await temporaryProject();
		const initialized = await initializeDirectoryProject({ projectRoot: root });
		expect(initialized.baseline_version).toHaveLength(64);
		expect(await readFile(resolve(root, "project.json"), "utf8")).toContain(`\${DASHSCOPE_API_KEY}`);

		const preview = await previewProjectBuild(root);
		expect(preview.can_build).toBe(true);
		const built = await commitProjectBuild({ projectRoot: root, baseRevision: preview.project_revision });
		expect(built.manifest.project_revision).toBe(preview.project_revision);
		expect((await getProjectBuildStatus(root)).stale).toBe(false);

		await writeFile(resolve(root, "agents/assistant/instructions.md"), "Changed while offline.\n");
		expect((await getProjectBuildStatus(root)).stale).toBe(true);
	});

	test("converts an existing YAML project with an in-place skill source", async () => {
		const root = await temporaryProject();
		await mkdir(resolve(root, "agents/assistant/skills/writer"), { recursive: true });
		await writeFile(resolve(root, "agents/assistant/skills/writer/SKILL.md"), "# Writer\n");
		await writeFile(
			resolve(root, "agents.yaml"),
			`version: "1"
providers:
  bailian: {}
defaults:
  provider: bailian
agents:
  assistant:
    name: Assistant
    model: qwen-plus
    instructions: Help the user.
    skills: [writer]
skills:
  writer:
    source: ./agents/assistant/skills/writer
`,
		);

		const initialized = await initializeDirectoryProject({ projectRoot: root });
		expect(initialized.converted_from_yaml).toBe(true);
		expect(await readFile(resolve(root, "agents/assistant/skills/writer/SKILL.md"), "utf8")).toBe("# Writer\n");
	});

	test("rejects an unsafe YAML conversion before creating directory source", async () => {
		const root = await temporaryProject();
		await writeFile(
			resolve(root, "agents.yaml"),
			`version: "1"
providers:
  bailian:
    api_key: plaintext-secret
defaults:
  provider: bailian
agents: {}
`,
		);

		await expect(initializeDirectoryProject({ projectRoot: root })).rejects.toThrow("environment variable");
		await expect(stat(resolve(root, "project.json"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("promotes a skill referenced by multiple agents during Build", async () => {
		const root = await temporaryProject();
		await initializeDirectoryProject({ projectRoot: root });
		const assistant = JSON.parse(await readFile(resolve(root, "agents/assistant/agent.json"), "utf8"));
		assistant.skills = ["writer"];
		await writeFile(resolve(root, "agents/assistant/agent.json"), `${JSON.stringify(assistant, null, 2)}\n`);
		await mkdir(resolve(root, "agents/assistant/skills/writer"), { recursive: true });
		await writeFile(resolve(root, "agents/assistant/skills/writer/skill.json"), '{"id":"writer"}\n');
		await writeFile(resolve(root, "agents/assistant/skills/writer/SKILL.md"), "# Writer\n");
		await mkdir(resolve(root, "agents/reviewer"), { recursive: true });
		await writeFile(
			resolve(root, "agents/reviewer/agent.json"),
			`${JSON.stringify({ name: "Reviewer", model: "qwen-plus", skills: ["writer"] }, null, 2)}\n`,
		);
		await writeFile(resolve(root, "agents/reviewer/instructions.md"), "Review writing.\n");

		const preview = await previewProjectBuild(root);
		expect(preview.organization_moves).toEqual([
			{
				skill_id: "writer",
				from: "agents/assistant/skills/writer",
				to: "skills/writer",
				reason: "shared",
			},
		]);
		await commitProjectBuild({ projectRoot: root, baseRevision: preview.project_revision });
		expect((await stat(resolve(root, "skills/writer/SKILL.md"))).isFile()).toBe(true);
	});

	test("rejects a live project mutation with 409 and recovers a dead process lock", async () => {
		const root = await temporaryProject();
		await initializeDirectoryProject({ projectRoot: root });
		const liveLease = await acquireDirectoryProjectMutation(root, "workbench_write");
		try {
			const preview = await previewProjectBuild(root);
			await expect(
				commitProjectBuild({ projectRoot: root, baseRevision: preview.project_revision }),
			).rejects.toMatchObject({ status: 409 });
		} finally {
			await liveLease.release();
		}

		const lockDirectory = resolve(root, ".openagentpack/mutation.lock");
		await mkdir(lockDirectory, { recursive: true });
		await writeFile(
			resolve(lockDirectory, "lease.json"),
			`${JSON.stringify({ pid: 2_147_483_647, kind: "dead_process" })}\n`,
		);
		const preview = await previewProjectBuild(root);
		await commitProjectBuild({ projectRoot: root, baseRevision: preview.project_revision });
		await expect(stat(lockDirectory)).rejects.toMatchObject({ code: "ENOENT" });
	});
});

describe("directory project versions", () => {
	test("stores source blobs and restores text and binary files without moving head", async () => {
		const root = await temporaryProject();
		await initializeDirectoryProject({ projectRoot: root });
		const versions = createDirectoryWorkspaceVersionService(root);
		const baseline = await versions.status();
		await mkdir(resolve(root, "agents/assistant/skills/data/assets"), { recursive: true });
		await writeFile(resolve(root, "agents/assistant/skills/data/skill.json"), '{"id":"data"}\n');
		await writeFile(resolve(root, "agents/assistant/skills/data/SKILL.md"), "# Data\n");
		await writeFile(resolve(root, "agents/assistant/skills/data/assets/blob.bin"), Uint8Array.from([0, 1, 2, 255]));
		const changedAgent = JSON.parse(await readFile(resolve(root, "agents/assistant/agent.json"), "utf8"));
		changedAgent.skills = ["data"];
		await writeFile(resolve(root, "agents/assistant/agent.json"), `${JSON.stringify(changedAgent, null, 2)}\n`);
		const prepared = await versions.prepareVersion();
		expect(prepared).not.toBeNull();
		const version = await versions.commitPrepared(prepared!, "Publish project");
		expect(version?.parent_version).toBe(baseline.head_version);

		await writeFile(resolve(root, "agents/assistant/instructions.md"), "Later edit.\n");
		const preview = await versions.previewVersion(version!.version_id);
		expect(preview.can_restore).toBe(true);
		await versions.restoreVersion(version!.version_id, {
			headVersion: preview.base_head_version,
			projectRevision: preview.base_project_revision,
		});
		expect(await readFile(resolve(root, "agents/assistant/skills/data/assets/blob.bin"))).toEqual(
			Buffer.from([0, 1, 2, 255]),
		);
		expect((await versions.status()).head_version).toBe(version!.version_id);
	});
});
