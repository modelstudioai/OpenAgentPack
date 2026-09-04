import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { resolveProjectConfigFromObject } from "@openagentpack/sdk";
import {
	acquireDirectoryProjectMutation,
	commitProjectBuild,
	createDirectoryWorkspaceVersionService,
	executeProjectPublish,
	getProjectBuildStatus,
	initializeDirectoryProject,
	planProjectPublish,
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
		expect(JSON.parse(await readFile(resolve(root, "project.json"), "utf8"))).toEqual({ version: "1" });
		await expect(stat(resolve(root, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
		await expect(stat(resolve(root, ".gitignore"))).rejects.toMatchObject({ code: "ENOENT" });

		const preview = await previewProjectBuild(root);
		expect(preview.can_build).toBe(true);
		expect(preview.canonical_yaml).toContain("provider: bailian");
		expect(preview.canonical_yaml).toContain(`api_key: \${DASHSCOPE_API_KEY}`);
		expect(preview.canonical_yaml).toContain(`base_url: \${BAILIAN_BASE_URL}`);
		expect(preview.source_files.map((file) => file.path)).not.toContain(".env");
		const built = await commitProjectBuild({ projectRoot: root, baseRevision: preview.project_revision });
		expect(built.manifest.project_revision).toBe(preview.project_revision);
		expect((await getProjectBuildStatus(root)).stale).toBe(false);

		await writeFile(resolve(root, "agents/assistant/instructions.md"), "Changed while offline.\n");
		expect((await getProjectBuildStatus(root)).stale).toBe(true);
	});

	test("does not modify an existing user-managed environment file during initialization", async () => {
		const root = await temporaryProject();
		await writeFile(resolve(root, ".env"), "DASHSCOPE_API_KEY=existing\n", { mode: 0o640 });
		await initializeDirectoryProject({ projectRoot: root });
		expect(await readFile(resolve(root, ".env"), "utf8")).toBe("DASHSCOPE_API_KEY=existing\n");
		if (process.platform !== "win32") expect((await stat(resolve(root, ".env"))).mode & 0o777).toBe(0o640);
		await expect(stat(resolve(root, ".gitignore"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("excludes nested environment files from source revisions and version snapshots", async () => {
		const root = await temporaryProject();
		await initializeDirectoryProject({ projectRoot: root });
		const before = await previewProjectBuild(root);
		const nestedEnvironmentPath = resolve(root, "agents/assistant/private/.env");
		await mkdir(resolve(root, "agents/assistant/private"), { recursive: true });
		await writeFile(nestedEnvironmentPath, "TOKEN=do-not-snapshot\n", { mode: 0o600 });

		const after = await previewProjectBuild(root);
		expect(after.project_revision).toBe(before.project_revision);
		expect(after.source_files.map((file) => file.path)).not.toContain("agents/assistant/private/.env");
		expect(after.source_files.some((file) => Buffer.from(file.content).includes("do-not-snapshot"))).toBe(false);

		const versions = createDirectoryWorkspaceVersionService(root);
		const prepared = await versions.prepareVersion();
		try {
			expect(prepared.snapshot.files.map((file) => file.path)).not.toContain("agents/assistant/private/.env");
			expect(prepared.snapshot.files.some((file) => Buffer.from(file.content).includes("do-not-snapshot"))).toBe(false);
		} finally {
			await versions.releasePrepared(prepared);
		}
	});

	test("converts an existing YAML project with an in-place skill source", async () => {
		const root = await temporaryProject();
		await mkdir(resolve(root, "agents/assistant/skills/writer"), { recursive: true });
		await writeFile(resolve(root, "agents/assistant/skills/writer/SKILL.md"), "# Writer\n");
		await writeFile(resolve(root, "input.txt"), "Input data\n");
		await writeFile(
			resolve(root, "agents.yaml"),
			`version: "1"
providers:
  bailian: {}
defaults:
  provider: bailian
environments:
  dev:
    config:
      type: cloud
vaults:
  secrets:
    display_name: Secrets
    credentials: []
files:
  input:
    source: ./input.txt
agents:
  assistant:
    name: Assistant
    model: qwen-plus
    instructions: Help the user.
    environment: dev
    vault: secrets
    skills: [writer]
    files:
      - file: input
        mount_path: /mnt/input.txt
skills:
  writer:
    source: ./agents/assistant/skills/writer
`,
		);

		const initialized = await initializeDirectoryProject({ projectRoot: root });
		expect(initialized.converted_from_yaml).toBe(true);
		expect(await readFile(resolve(root, "agents/assistant/skills/writer/SKILL.md"), "utf8")).toBe("# Writer\n");
		expect((await stat(resolve(root, "agents/assistant/environments/dev/environment.json"))).isFile()).toBe(true);
		expect((await stat(resolve(root, "agents/assistant/vaults/secrets/vault.json"))).isFile()).toBe(true);
		expect((await stat(resolve(root, "agents/assistant/files/input/input.txt"))).isFile()).toBe(true);
		expect(JSON.parse(await readFile(resolve(root, "agents/assistant/agent.json"), "utf8")).files).toEqual([
			{ file: "input", mount_path: "/mnt/input.txt" },
		]);
		const project = JSON.parse(await readFile(resolve(root, "project.json"), "utf8"));
		expect(project.providers).toBeUndefined();
		expect(project.defaults).toBeUndefined();
		expect(project.environments).toBeUndefined();
		expect(project.vaults).toBeUndefined();
		expect(project.files).toBeUndefined();
	});

	test("rejects conversion from a non-Bailian YAML project", async () => {
		const root = await temporaryProject();
		await writeFile(
			resolve(root, "agents.yaml"),
			`version: "1"
providers:
  qoder: {}
defaults:
  provider: qoder
agents: {}
`,
		);

		await expect(initializeDirectoryProject({ projectRoot: root })).rejects.toThrow("cannot convert providers: qoder");
		await expect(stat(resolve(root, "project.json"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("rejects Agent instruction sources outside the project root", async () => {
		const container = await temporaryProject();
		const root = resolve(container, "project");
		await mkdir(root);
		await writeFile(resolve(container, "outside-instructions.md"), "private instructions\n");
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
    instructions: ../outside-instructions.md
`,
		);

		await expect(initializeDirectoryProject({ projectRoot: root })).rejects.toThrow(
			"Agent instructions escapes the project root",
		);
		await expect(stat(resolve(root, "agents/assistant/instructions.md"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("rejects Skill sources outside the project root", async () => {
		const container = await temporaryProject();
		const root = resolve(container, "project");
		await mkdir(root);
		await mkdir(resolve(container, "outside-skill"));
		await writeFile(resolve(container, "outside-skill/SKILL.md"), "# Private skill\n");
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
    source: ../outside-skill
`,
		);

		await expect(initializeDirectoryProject({ projectRoot: root })).rejects.toThrow(
			"Skill source escapes the project root",
		);
		await expect(stat(resolve(root, "agents/assistant/skills/writer/SKILL.md"))).rejects.toMatchObject({
			code: "ENOENT",
		});
	});

	test("rejects Skill source symlinks that resolve outside the project root", async () => {
		if (process.platform === "win32") return;
		const container = await temporaryProject();
		const root = resolve(container, "project");
		await mkdir(root);
		await mkdir(resolve(container, "outside-skill"));
		await writeFile(resolve(container, "outside-skill/SKILL.md"), "# Private skill\n");
		await symlink(resolve(container, "outside-skill"), resolve(root, "linked-skill"));
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
    source: ./linked-skill
`,
		);

		await expect(initializeDirectoryProject({ projectRoot: root })).rejects.toThrow(
			"Skill source resolves outside the project root",
		);
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
				resource_type: "skill",
				resource_id: "writer",
				from: "agents/assistant/skills/writer",
				to: "skills/writer",
				reason: "shared",
			},
		]);
		await commitProjectBuild({ projectRoot: root, baseRevision: preview.project_revision });
		expect((await stat(resolve(root, "skills/writer/SKILL.md"))).isFile()).toBe(true);
	});

	test("assembles Agent-local resources and promotes resources shared by another Agent", async () => {
		const root = await temporaryProject();
		await initializeDirectoryProject({ projectRoot: root });
		const assistantPath = resolve(root, "agents/assistant/agent.json");
		const assistant = JSON.parse(await readFile(assistantPath, "utf8"));
		Object.assign(assistant, {
			environment: "dev",
			vault: "secrets",
			files: [{ file: "input", mount_path: "/mnt/input.txt" }],
		});
		await writeFile(assistantPath, `${JSON.stringify(assistant, null, 2)}\n`);
		await mkdir(resolve(root, "agents/reviewer"), { recursive: true });
		await writeFile(
			resolve(root, "agents/reviewer/agent.json"),
			`${JSON.stringify(
				{
					name: "Reviewer",
					model: "qwen-plus",
					environment: "dev",
					vault: "secrets",
					files: [{ file: "input", mount_path: "/mnt/review-input.txt" }],
				},
				null,
				2,
			)}\n`,
		);
		await writeFile(resolve(root, "agents/reviewer/instructions.md"), "Review the result.\n");
		await writeResource(root, "agents/assistant/environments/dev/environment.json", {
			id: "dev",
			config: { type: "cloud", networking: { type: "unrestricted" } },
		});
		await writeResource(root, "agents/assistant/vaults/secrets/vault.json", {
			id: "secrets",
			display_name: "Secrets",
			credentials: [],
		});
		await writeResource(root, "agents/assistant/files/input/file.json", {
			id: "input",
			source: "./input.txt",
		});
		await writeFile(resolve(root, "agents/assistant/files/input/input.txt"), "Input data\n");

		const preview = await previewProjectBuild(root);
		expect(preview.can_build).toBe(true);
		expect(preview.organization_moves.map((move) => `${move.resource_type}.${move.resource_id}`)).toEqual([
			"environment.dev",
			"vault.secrets",
			"file.input",
		]);
		expect(preview.canonical_yaml).toContain("environments:");
		expect(preview.canonical_yaml).toContain("vaults:");
		expect(preview.canonical_yaml).toContain("files:");
		expect(preview.canonical_yaml).toContain("../../resources/files/input/input.txt");
		expect(preview.canonical_yaml).toContain("mount_path: /mnt/input.txt");
		const preparedVersion = await createDirectoryWorkspaceVersionService(root).prepareVersion();
		try {
			expect(preparedVersion.snapshot.files.map((file) => file.path)).toContain(
				"agents/assistant/environments/dev/environment.json",
			);
			expect(preparedVersion.snapshot.files.map((file) => file.path)).toContain(
				"agents/assistant/files/input/input.txt",
			);
		} finally {
			await createDirectoryWorkspaceVersionService(root).releasePrepared(preparedVersion);
		}

		await commitProjectBuild({ projectRoot: root, baseRevision: preview.project_revision });
		expect((await stat(resolve(root, "resources/environments/dev/environment.json"))).isFile()).toBe(true);
		expect((await stat(resolve(root, "resources/vaults/secrets/vault.json"))).isFile()).toBe(true);
		expect((await stat(resolve(root, "resources/files/input/file.json"))).isFile()).toBe(true);
	});

	test("rejects managed resource declarations in project.json", async () => {
		const root = await temporaryProject();
		await initializeDirectoryProject({ projectRoot: root });
		const projectPath = resolve(root, "project.json");
		const project = JSON.parse(await readFile(projectPath, "utf8"));
		project.environments = { dev: { config: { type: "cloud" } } };
		await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`);

		const preview = await previewProjectBuild(root);
		expect(preview.can_build).toBe(false);
		expect(preview.diagnostics[0]?.message).toContain("project.json cannot declare environments");
	});

	test("rejects provider declarations in project.json because directory projects use Bailian", async () => {
		const root = await temporaryProject();
		await initializeDirectoryProject({ projectRoot: root });
		const projectPath = resolve(root, "project.json");
		await writeFile(
			projectPath,
			`${JSON.stringify(
				{
					version: "1",
					providers: { bailian: {} },
					defaults: { provider: "bailian" },
				},
				null,
				2,
			)}\n`,
		);

		const preview = await previewProjectBuild(root);
		expect(preview.can_build).toBe(false);
		expect(preview.diagnostics[0]?.message).toContain("directory projects use 'bailian' automatically");
	});

	test("rejects incomplete Agent-local resource directories", async () => {
		const root = await temporaryProject();
		await initializeDirectoryProject({ projectRoot: root });
		await mkdir(resolve(root, "agents/assistant/environments/dev"), { recursive: true });

		const preview = await previewProjectBuild(root);
		expect(preview.can_build).toBe(false);
		expect(preview.diagnostics[0]?.message).toContain("environment.json is required");
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

describe("directory project publish", () => {
	test("rejects execution when the fresh plan differs from the reviewed plan", async () => {
		const root = await temporaryProject();
		await initializeDirectoryProject({ projectRoot: root });
		const buildPreview = await previewProjectBuild(root);
		await commitProjectBuild({ projectRoot: root, baseRevision: buildPreview.project_revision });
		const reviewedConfig = await resolvedPublishConfig(root, "qwen-plus");
		const changedConfig = await resolvedPublishConfig(root, "qwen-max");
		const reviewedPlan = await planProjectPublish(root, {
			refresh: false,
			resolveBuild: async () => reviewedConfig,
		});

		expect(reviewedPlan.plan_fingerprint).toMatch(/^[a-f0-9]{64}$/);
		await expect(
			executeProjectPublish({
				projectRoot: root,
				expectedProjectRevision: reviewedPlan.project_revision,
				expectedYamlHash: reviewedPlan.build_manifest.yaml_hash,
				expectedPlanFingerprint: reviewedPlan.plan_fingerprint,
				refresh: false,
				policy: "force",
				resolveBuild: async () => changedConfig,
			}),
		).rejects.toThrow("Publish plan changed");
		expect((await createDirectoryWorkspaceVersionService(root).status()).write_blockers).toEqual([]);
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

	test("restores a historical file over an empty current directory", async () => {
		const root = await temporaryProject();
		await initializeDirectoryProject({ projectRoot: root });
		const versions = createDirectoryWorkspaceVersionService(root);
		const shapePath = resolve(root, "shape");
		await writeFile(shapePath, "historical file\n");
		const filePrepared = await versions.prepareVersion();
		const fileVersion = await versions.commitPrepared(filePrepared, "File shape");

		await rm(shapePath);
		await mkdir(shapePath);
		await writeFile(resolve(shapePath, "current-child.txt"), "current data\n");
		const directoryPrepared = await versions.prepareVersion();
		await versions.commitPrepared(directoryPrepared, "Directory shape");

		const preview = await versions.previewVersion(fileVersion!.version_id);
		await versions.restoreVersion(fileVersion!.version_id, {
			headVersion: preview.base_head_version,
			projectRevision: preview.base_project_revision,
		});
		expect(await readFile(shapePath, "utf8")).toBe("historical file\n");
	});

	test("rolls back current source when Restore meets an unversioned path conflict", async () => {
		const root = await temporaryProject();
		await initializeDirectoryProject({ projectRoot: root });
		const versions = createDirectoryWorkspaceVersionService(root);
		const shapePath = resolve(root, "shape");
		await writeFile(shapePath, "historical file\n");
		const filePrepared = await versions.prepareVersion();
		const fileVersion = await versions.commitPrepared(filePrepared, "File shape");

		await rm(shapePath);
		await mkdir(shapePath);
		const currentChildPath = resolve(shapePath, "current-child.txt");
		await writeFile(currentChildPath, "current data\n");
		const directoryPrepared = await versions.prepareVersion();
		await versions.commitPrepared(directoryPrepared, "Directory shape");
		const nestedEnvironmentPath = resolve(shapePath, ".env");
		await writeFile(nestedEnvironmentPath, "TOKEN=keep-private\n", { mode: 0o600 });

		const preview = await versions.previewVersion(fileVersion!.version_id);
		const currentRevision = preview.base_project_revision;
		await expect(
			versions.restoreVersion(fileVersion!.version_id, {
				headVersion: preview.base_head_version,
				projectRevision: preview.base_project_revision,
			}),
		).rejects.toThrow("destination directory contains unversioned files");
		expect(await readFile(currentChildPath, "utf8")).toBe("current data\n");
		expect(await readFile(nestedEnvironmentPath, "utf8")).toBe("TOKEN=keep-private\n");
		expect((await previewProjectBuild(root)).project_revision).toBe(currentRevision);
	});
});

async function writeResource(root: string, path: string, value: Record<string, unknown>): Promise<void> {
	const destination = resolve(root, path);
	await mkdir(resolve(destination, ".."), { recursive: true });
	await writeFile(destination, `${JSON.stringify(value, null, 2)}\n`);
}

async function resolvedPublishConfig(projectRoot: string, model: string) {
	return resolveProjectConfigFromObject(
		{
			version: "1",
			providers: {
				bailian: {
					api_key: "test-api-key",
					base_url: "https://example.com/api/v1/agentstudio",
				},
			},
			defaults: { provider: "bailian" },
			agents: {
				assistant: {
					model,
					instructions: "Help the user.",
				},
			},
		},
		{
			projectName: "publish-plan-test",
			basePath: resolve(projectRoot, ".openagentpack/build"),
		},
	);
}
