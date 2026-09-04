import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireDirectoryProjectMutation } from "@openagentpack/project-workspace";
import {
	commitDeclarationChange,
	listProjectDeclarations,
	previewDeclarationChange,
} from "../src/services/project-declarations";
import { ProjectRuntimeManager } from "../src/services/project-manager";
import { projectMutationCoordinator } from "../src/services/project-mutations";

const directories: string[] = [];
const managers: ProjectRuntimeManager[] = [];
process.env.DASHSCOPE_API_KEY ??= "test-bailian-api-key";
process.env.BAILIAN_BASE_URL ??= "https://example.com/api/v1/agentstudio";

afterEach(async () => {
	for (const manager of managers.splice(0)) manager.close();
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("directory project declaration editing", () => {
	test("lists authored resources, editable Markdown, references, and redacted secrets", async () => {
		const { manager } = await projectFixture();
		const listed = await listProjectDeclarations(manager);
		const vault = resource(listed.resources, "vault", "secrets");
		const agent = resource(listed.resources, "agent", "assistant");
		const skill = resource(listed.resources, "skill", "helper");
		const file = resource(listed.resources, "file", "input");

		expect(listed.resources.map((entry) => `${entry.type}.${entry.id}`)).toContain("environment.sandbox");
		expect(agent.declaration.instructions).toBe("External instructions\n");
		expect(agent.read_only_paths).not.toContainEqual(["instructions"]);
		expect(skill.declaration.content).toBe("# Helper\n\nHelp the selected Agent.\n");
		expect(file.declaration.source).toBe("./input.txt");
		expect(file.owner_agent).toBe("assistant");
		expect(file.references.map((reference) => reference.path)).toEqual(["agents.assistant.files"]);
		expect(agent.references.map((reference) => reference.path)).toContain("deployments.daily.agent");
		expect(vault.declaration.credentials).toEqual([
			{
				name: "bearer",
				type: "static_bearer",
				mcp_server_url: "https://example.com/mcp",
				access_token: "[redacted]",
			},
		]);
		expect(JSON.stringify(listed)).not.toContain("literal-secret");
	});

	test("previews without writing, then atomically updates Agent JSON and instructions Markdown", async () => {
		const { directory, manager } = await projectFixture();
		const metadataPath = join(directory, "agents/assistant/agent.json");
		const instructionsPath = join(directory, "agents/assistant/instructions.md");
		await chmod(metadataPath, 0o640);
		const beforeMetadata = await readFile(metadataPath, "utf8");
		const beforeInstructions = await readFile(instructionsPath, "utf8");
		const listed = await listProjectDeclarations(manager);
		const input = {
			type: "agent" as const,
			id: "assistant",
			baseRevision: listed.revision,
			action: "update" as const,
			operations: [
				{ op: "set" as const, path: ["description"], value: "Updated locally" },
				{ op: "set" as const, path: ["instructions"], value: "Updated instructions\n" },
			],
		};

		const preview = await previewDeclarationChange(input, manager);
		expect(preview.can_commit).toBe(true);
		expect(preview.after_yaml).toContain("Updated locally");
		expect(preview.after_yaml).toContain("Updated instructions");
		expect(await readFile(metadataPath, "utf8")).toBe(beforeMetadata);
		expect(await readFile(instructionsPath, "utf8")).toBe(beforeInstructions);

		const committed = await commitDeclarationChange(input, manager);
		expect(committed.new_revision).not.toBe(listed.revision);
		expect(JSON.parse(await readFile(metadataPath, "utf8"))).toMatchObject({ description: "Updated locally" });
		expect(await readFile(instructionsPath, "utf8")).toBe("Updated instructions\n");
		expect((await stat(metadataPath)).mode & 0o777).toBe(0o640);
	});

	test("updates Skill Markdown and preserves authored local File paths", async () => {
		const { directory, manager } = await projectFixture();
		let listed = await listProjectDeclarations(manager);
		await commitDeclarationChange(
			{
				type: "skill",
				id: "helper",
				baseRevision: listed.revision,
				action: "update",
				operations: [{ op: "set", path: ["content"], value: "# Helper\n\nUpdated.\n" }],
			},
			manager,
		);
		expect(await readFile(join(directory, "skills/helper/SKILL.md"), "utf8")).toContain("Updated.");

		listed = await listProjectDeclarations(manager);
		await commitDeclarationChange(
			{
				type: "file",
				id: "input",
				baseRevision: listed.revision,
				action: "update",
				operations: [{ op: "set", path: ["name"], value: "Input File" }],
			},
			manager,
		);
		const project = JSON.parse(await readFile(join(directory, "project.json"), "utf8"));
		expect(project.files).toBeUndefined();
		expect(JSON.parse(await readFile(join(directory, "agents/assistant/files/input/file.json"), "utf8"))).toEqual({
			id: "input",
			source: "./input.txt",
			name: "Input File",
		});
	});

	test("rejects stale revisions, missing resources, and writes during another mutation", async () => {
		const { directory, manager } = await projectFixture();
		const listed = await listProjectDeclarations(manager);
		await writeFile(join(directory, "notes.md"), "external edit\n");

		await expect(
			previewDeclarationChange(
				{
					type: "agent",
					id: "assistant",
					baseRevision: listed.revision,
					action: "update",
					operations: [{ op: "set", path: ["description"], value: "stale" }],
				},
				manager,
			),
		).rejects.toMatchObject({ status: 409 });
		await manager.refreshAfterSourceMutation();
		await expect(
			previewDeclarationChange(
				{
					type: "agent",
					id: "missing",
					baseRevision: manager.getSnapshot().revision!,
					action: "update",
					operations: [{ op: "set", path: ["description"], value: "new" }],
				},
				manager,
			),
		).rejects.toMatchObject({ status: 404 });

		const filesystemLease = await acquireDirectoryProjectMutation(directory, "publish");
		try {
			await expect(
				commitDeclarationChange(
					{
						type: "agent",
						id: "assistant",
						baseRevision: manager.getSnapshot().revision!,
						action: "update",
						operations: [{ op: "set", path: ["description"], value: "blocked" }],
					},
					manager,
				),
			).rejects.toThrow(/busy/i);
		} finally {
			await filesystemLease.release();
		}
	});

	test("blocks referenced deletes and reports every protected dependency", async () => {
		const { manager } = await projectFixture();
		const listed = await listProjectDeclarations(manager);
		const paths = (type: "agent" | "environment" | "skill" | "vault" | "file", id: string) =>
			resource(listed.resources, type, id).references.map((reference) => reference.path);

		expect(paths("agent", "assistant")).toContain("deployments.daily.agent");
		expect(paths("environment", "sandbox")).toEqual(["agents.assistant.environment", "deployments.daily.environment"]);
		expect(paths("skill", "helper")).toEqual(["agents.assistant.skills"]);
		expect(paths("vault", "secrets")).toEqual(["agents.assistant.vault", "deployments.daily.vaults"]);
		expect(paths("file", "input")).toEqual(["agents.assistant.files"]);
		const filePreview = await previewDeclarationChange(
			{ type: "file", id: "input", baseRevision: listed.revision, action: "delete" },
			manager,
		);
		expect(filePreview.can_commit).toBe(false);

		const preview = await previewDeclarationChange(
			{ type: "agent", id: "assistant", baseRevision: listed.revision, action: "delete" },
			manager,
		);
		expect(preview.can_commit).toBe(false);
		await expect(
			commitDeclarationChange(
				{ type: "agent", id: "assistant", baseRevision: listed.revision, action: "delete" },
				manager,
			),
		).rejects.toMatchObject({ status: 409 });
	});

	test("removes an unreferenced Agent into local trash and leaves State untouched", async () => {
		const { directory, manager } = await projectFixture({ deployment: false });
		const statePath = join(directory, ".openagentpack/state.json");
		await mkdir(join(directory, ".openagentpack"), { recursive: true });
		await writeFile(statePath, '{"remote":"latest"}\n');
		const listed = await listProjectDeclarations(manager);

		await commitDeclarationChange(
			{ type: "agent", id: "assistant", baseRevision: listed.revision, action: "delete" },
			manager,
		);
		expect(await stat(join(directory, "agents/assistant")).catch(() => null)).toBeNull();
		expect((await readdir(join(directory, ".openagentpack/trash")))[0]).toStartWith("agent-assistant-");
		expect(await readFile(statePath, "utf8")).toBe('{"remote":"latest"}\n');
	});

	test("removes a File declaration without deleting its local source", async () => {
		const { directory, manager } = await projectFixture({ fileMount: false });
		const listed = await listProjectDeclarations(manager);
		await commitDeclarationChange(
			{ type: "file", id: "input", baseRevision: listed.revision, action: "delete" },
			manager,
		);

		expect(await stat(join(directory, "agents/assistant/files/input/file.json")).catch(() => null)).toBeNull();
		expect(await readFile(join(directory, "agents/assistant/files/input/input.txt"), "utf8")).toBe("Keep local file\n");
	});

	test("preserves redacted Vault values and redacts replacement secrets in Preview", async () => {
		const { directory, manager } = await projectFixture();
		const listed = await listProjectDeclarations(manager);
		const vault = resource(listed.resources, "vault", "secrets");
		await commitDeclarationChange(
			{
				type: "vault",
				id: "secrets",
				baseRevision: listed.revision,
				action: "update",
				operations: [{ op: "set", path: ["credentials"], value: vault.declaration.credentials }],
			},
			manager,
		);
		expect(await readFile(join(directory, "agents/assistant/vaults/secrets/vault.json"), "utf8")).toContain(
			"literal-secret",
		);

		const refreshed = await listProjectDeclarations(manager);
		const preview = await previewDeclarationChange(
			{
				type: "vault",
				id: "secrets",
				baseRevision: refreshed.revision,
				action: "update",
				operations: [
					{
						op: "set",
						path: ["credentials"],
						value: [{ name: "bearer", type: "static_bearer", access_token: "replacement-secret" }],
					},
				],
			},
			manager,
		);
		expect(JSON.stringify(preview)).not.toContain("literal-secret");
		expect(JSON.stringify(preview)).not.toContain("replacement-secret");
		expect(preview.after_yaml).toContain("[redacted]");
	});

	test("in-process Apply coordination still blocks Workbench writes", async () => {
		const { manager } = await projectFixture();
		const listed = await listProjectDeclarations(manager);
		const lease = projectMutationCoordinator.acquire("project_apply");
		try {
			await expect(
				commitDeclarationChange(
					{
						type: "agent",
						id: "assistant",
						baseRevision: listed.revision,
						action: "update",
						operations: [{ op: "set", path: ["description"], value: "draft" }],
					},
					manager,
				),
			).rejects.toMatchObject({ status: 409 });
		} finally {
			lease.release();
		}
	});
});

async function projectFixture(options: { deployment?: boolean; fileMount?: boolean } = {}): Promise<{
	directory: string;
	manager: ProjectRuntimeManager;
}> {
	const directory = await mkdtemp(join(tmpdir(), "openagentpack-declarations-"));
	directories.push(directory);
	await mkdir(join(directory, "agents/assistant"), { recursive: true });
	await mkdir(join(directory, "skills/helper"), { recursive: true });
	await mkdir(join(directory, "agents/assistant/environments/sandbox"), { recursive: true });
	await mkdir(join(directory, "agents/assistant/vaults/secrets"), { recursive: true });
	await mkdir(join(directory, "agents/assistant/files/input"), { recursive: true });
	await writeFile(join(directory, "agents/assistant/instructions.md"), "External instructions\n");
	await writeFile(
		join(directory, "agents/assistant/agent.json"),
		`${JSON.stringify(
			{
				description: "Existing Agent",
				model: "qwen-plus",
				environment: "sandbox",
				skills: ["helper"],
				vault: "secrets",
				...(options.fileMount === false ? {} : { files: [{ file: "input", mount_path: "/mnt/input.txt" }] }),
			},
			null,
			2,
		)}\n`,
	);
	await writeFile(join(directory, "skills/helper/skill.json"), '{"id":"helper","name":"Helper"}\n');
	await writeFile(join(directory, "skills/helper/SKILL.md"), "# Helper\n\nHelp the selected Agent.\n");
	await writeFile(
		join(directory, "agents/assistant/environments/sandbox/environment.json"),
		'{"id":"sandbox","config":{"type":"cloud"}}\n',
	);
	await writeFile(
		join(directory, "agents/assistant/vaults/secrets/vault.json"),
		`${JSON.stringify(
			{
				id: "secrets",
				display_name: "Secrets",
				credentials: [
					{
						name: "bearer",
						type: "static_bearer",
						mcp_server_url: "https://example.com/mcp",
						access_token: "literal-secret",
					},
				],
			},
			null,
			2,
		)}\n`,
	);
	await writeFile(join(directory, "agents/assistant/files/input/file.json"), '{"id":"input","source":"./input.txt"}\n');
	await writeFile(join(directory, "agents/assistant/files/input/input.txt"), "Keep local file\n");
	const project: Record<string, unknown> = { version: "1" };
	if (options.deployment !== false) {
		project.deployments = {
			daily: {
				agent: "assistant",
				environment: "sandbox",
				vaults: ["secrets"],
				initial_events: [{ type: "user.message", content: "run" }],
			},
		};
	}
	await writeFile(join(directory, "project.json"), `${JSON.stringify(project, null, 2)}\n`);
	const manager = new ProjectRuntimeManager(directory);
	managers.push(manager);
	await manager.ensureStarted();
	if (manager.getSnapshot().status !== "valid") throw new Error(JSON.stringify(manager.getSnapshot().diagnostics));
	return { directory, manager };
}

function resource(
	resources: Awaited<ReturnType<typeof listProjectDeclarations>>["resources"],
	type: (typeof resources)[number]["type"],
	id: string,
) {
	const found = resources.find((entry) => entry.type === type && entry.id === id);
	if (!found) throw new Error(`Missing ${type}.${id}`);
	return found;
}
