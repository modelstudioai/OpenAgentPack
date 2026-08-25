import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	commitDeclarationChange,
	listProjectDeclarations,
	previewDeclarationChange,
} from "../src/services/project-declarations";
import { ProjectRuntimeManager } from "../src/services/project-manager";
import { projectMutationCoordinator } from "../src/services/project-mutations";

const directories: string[] = [];
const managers: ProjectRuntimeManager[] = [];

afterEach(async () => {
	for (const manager of managers.splice(0)) manager.close();
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("project declaration editing", () => {
	test("lists only existing supported declarations and redacts literal secrets", async () => {
		const { manager } = await projectFixture();
		const listed = await listProjectDeclarations(manager);
		const vault = listed.resources.find((resource) => resource.type === "vault" && resource.id === "secrets");
		const agent = listed.resources.find((resource) => resource.type === "agent" && resource.id === "assistant");

		expect(listed.resources.map((resource) => `${resource.type}.${resource.id}`)).toContain("environment.sandbox");
		expect(vault?.declaration.credentials).toEqual([
			{
				name: "bearer",
				type: "static_bearer",
				mcp_server_url: "https://example.com/mcp",
				access_token: "[redacted]",
			},
		]);
		expect(agent?.read_only_paths).toContainEqual(["instructions"]);
		expect(JSON.stringify(listed)).not.toContain("literal-secret");
	});

	test("previews without writing, then atomically updates YAML while preserving comments and mode", async () => {
		const { directory, configPath, manager } = await projectFixture();
		await chmod(configPath, 0o640);
		const before = await readFile(configPath, "utf8");
		const listed = await listProjectDeclarations(manager);
		const input = {
			type: "agent" as const,
			id: "assistant",
			baseRevision: listed.revision,
			action: "update" as const,
			operations: [{ op: "set" as const, path: ["description"], value: "Updated locally" }],
		};

		const preview = await previewDeclarationChange(input, manager);
		expect(preview.can_commit).toBe(true);
		expect(preview.after_yaml).toContain("Updated locally");
		expect(preview.references.map((reference) => reference.path)).toContain("deployments.daily.agent");
		expect(await readFile(configPath, "utf8")).toBe(before);

		const committed = await commitDeclarationChange(input, manager);
		const after = await readFile(configPath, "utf8");
		expect(committed.new_revision).not.toBe(listed.revision);
		expect(after).toBe(before.replace("description: Existing Agent", "description: Updated locally"));
		expect(after).toContain("# keep this project comment");
		expect(after).toContain("description: Updated locally");
		expect((await stat(configPath)).mode & 0o777).toBe(0o640);
		expect(await readFile(join(directory, "instructions.md"), "utf8")).toBe("External instructions\n");
	});

	test("adds and removes fields without reformatting untouched declaration content", async () => {
		const { configPath, manager } = await projectFixture();
		const before = await readFile(configPath, "utf8");
		const listed = await listProjectDeclarations(manager);
		await commitDeclarationChange(
			{
				type: "agent",
				id: "assistant",
				baseRevision: listed.revision,
				action: "update",
				operations: [
					{ op: "remove", path: ["description"] },
					{ op: "set", path: ["name"], value: "Assistant" },
				],
			},
			manager,
		);
		const after = await readFile(configPath, "utf8");
		const expected = before
			.replace("    description: Existing Agent # keep agent comment\n", "")
			.replace("    memory_stores: [memory]\n", "    memory_stores: [memory]\n    name: Assistant\n");

		expect(after).toBe(expected);
	});

	test("rejects stale revisions and never creates a missing resource", async () => {
		const { configPath, manager } = await projectFixture();
		const listed = await listProjectDeclarations(manager);
		await writeFile(configPath, `${await readFile(configPath, "utf8")}\n# external edit\n`, "utf8");
		await manager.refreshAfterSourceMutation();

		expect(
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
		expect(
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
	});

	test("rejects stale revisions before the file watcher reloads", async () => {
		const { configPath, manager } = await projectFixture();
		const listed = await listProjectDeclarations(manager);
		await writeFile(configPath, `${await readFile(configPath, "utf8")}\n# external edit\n`, "utf8");

		expect(
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
	});

	test("preserves a draft but rejects declaration writes while Apply owns the project mutation lease", async () => {
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

	test("blocks referenced deletes and reports every declaration path", async () => {
		const { manager } = await projectFixture();
		const listed = await listProjectDeclarations(manager);
		const preview = await previewDeclarationChange(
			{
				type: "agent",
				id: "assistant",
				baseRevision: listed.revision,
				action: "delete",
			},
			manager,
		);

		expect(preview.can_commit).toBe(false);
		expect(preview.references.map((reference) => reference.path)).toContain("deployments.daily.agent");
		expect(
			commitDeclarationChange(
				{
					type: "agent",
					id: "assistant",
					baseRevision: listed.revision,
					action: "delete",
				},
				manager,
			),
		).rejects.toMatchObject({ status: 409 });
	});

	test("reports Agent and Deployment reverse references for every protected dependency type", async () => {
		const { manager } = await projectFixture();
		const listed = await listProjectDeclarations(manager);
		const paths = (type: "environment" | "skill" | "vault" | "memory_store", id: string) =>
			listed.resources
				.find((resource) => resource.type === type && resource.id === id)!
				.references.map((reference) => reference.path);

		expect(paths("environment", "sandbox")).toEqual(["agents.assistant.environment", "deployments.daily.environment"]);
		expect(paths("skill", "helper")).toEqual(["agents.assistant.skills"]);
		expect(paths("vault", "secrets")).toEqual(["agents.assistant.vault", "deployments.daily.vaults"]);
		expect(paths("memory_store", "memory")).toEqual([
			"agents.assistant.memory_stores",
			"deployments.daily.memory_stores",
			"deployments.daily.resources",
		]);
	});

	test("protects Agents referenced by Multi-Agent and Channel declarations", async () => {
		const multiAgentManager = await managerFixture(`version: "1"
providers:
  claude:
    api_key: test-key
defaults:
  provider: claude
agents:
  worker:
    model: sonnet
    instructions: Work.
  coordinator:
    model: sonnet
    instructions: Coordinate.
    multiagent:
      type: coordinator
      agents: [worker]
`);
		const multiAgentResources = await listProjectDeclarations(multiAgentManager);
		expect(
			multiAgentResources.resources.find((resource) => resource.type === "agent" && resource.id === "worker")
				?.references,
		).toContainEqual({ type: "agent", id: "coordinator", path: "agents.coordinator.multiagent.agents" });

		const channelManager = await managerFixture(`version: "1"
providers:
  qoder:
    api_key: test-key
defaults:
  provider: qoder
  identity: chen
identities:
  chen:
    external_id: user_456
environments:
  byoc:
    environment_id: env_byoc
    config:
      type: self_hosted
agents:
  assistant:
    model:
      qoder: auto
    instructions: Help.
    environment: byoc
    delivery:
      qoder:
        type: forward
channels:
  dingtalk:
    agent: assistant
    type: dingtalk
    credentials:
      client_id: client
      client_secret: secret
`);
		const channelResources = await listProjectDeclarations(channelManager);
		expect(
			channelResources.resources.find((resource) => resource.type === "agent" && resource.id === "assistant")
				?.references,
		).toContainEqual({ type: "channel", id: "dingtalk", path: "channels.dingtalk.agent" });
	});

	test("deletes an unreferenced Agent declaration and leaves source files untouched", async () => {
		const { directory, configPath, manager } = await projectFixture({ deployment: false });
		const listed = await listProjectDeclarations(manager);
		const committed = await commitDeclarationChange(
			{
				type: "agent",
				id: "assistant",
				baseRevision: listed.revision,
				action: "delete",
			},
			manager,
		);

		expect(committed.can_commit).toBe(true);
		expect(await readFile(configPath, "utf8")).not.toContain("assistant:");
		expect(await readFile(join(directory, "instructions.md"), "utf8")).toBe("External instructions\n");
	});

	test("deletes a File declaration without deleting or reformatting the local source file", async () => {
		const { directory, configPath, manager } = await projectFixture();
		const before = await readFile(configPath, "utf8");
		const listed = await listProjectDeclarations(manager);
		await commitDeclarationChange(
			{
				type: "file",
				id: "input",
				baseRevision: listed.revision,
				action: "delete",
			},
			manager,
		);

		expect(await readFile(configPath, "utf8")).toBe(before.replace("files:\n  input:\n    source: ./keep.txt\n", ""));
		expect(await readFile(join(directory, "keep.txt"), "utf8")).toBe("Keep local file\n");
	});

	test("keeps file-backed content read-only and preserves redacted vault values", async () => {
		const { configPath, manager } = await projectFixture();
		let listed = await listProjectDeclarations(manager);
		expect(
			previewDeclarationChange(
				{
					type: "agent",
					id: "assistant",
					baseRevision: listed.revision,
					action: "update",
					operations: [{ op: "set", path: ["instructions"], value: "inline replacement" }],
				},
				manager,
			),
		).rejects.toMatchObject({ status: 400 });
		expect(
			previewDeclarationChange(
				{
					type: "file",
					id: "input",
					baseRevision: listed.revision,
					action: "update",
					operations: [{ op: "set", path: ["source"], value: "./replacement.txt" }],
				},
				manager,
			),
		).rejects.toMatchObject({ status: 400 });

		const vault = listed.resources.find((resource) => resource.type === "vault" && resource.id === "secrets")!;
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
		expect(await readFile(configPath, "utf8")).toContain("access_token: literal-secret");
		listed = await listProjectDeclarations(manager);
		expect(JSON.stringify(listed)).not.toContain("literal-secret");
	});

	test("redacts replacement secrets from Preview YAML and diagnostics", async () => {
		const { manager } = await projectFixture();
		const listed = await listProjectDeclarations(manager);
		const preview = await previewDeclarationChange(
			{
				type: "vault",
				id: "secrets",
				baseRevision: listed.revision,
				action: "update",
				operations: [
					{
						op: "set",
						path: ["credentials"],
						value: [
							{
								name: "bearer",
								type: "static_bearer",
								mcp_server_url: "https://example.com/mcp",
								access_token: "replacement-secret",
							},
						],
					},
				],
			},
			manager,
		);

		expect(JSON.stringify(preview)).not.toContain("literal-secret");
		expect(JSON.stringify(preview)).not.toContain("replacement-secret");
		expect(preview.after_yaml).toContain("[redacted]");
	});
});

async function projectFixture(options: { deployment?: boolean } = {}): Promise<{
	directory: string;
	configPath: string;
	manager: ProjectRuntimeManager;
}> {
	const directory = await mkdtemp(join(tmpdir(), "openagentpack-declarations-"));
	directories.push(directory);
	const configPath = join(directory, "agents.yaml");
	await writeFile(join(directory, "instructions.md"), "External instructions\n", "utf8");
	await writeFile(join(directory, "keep.txt"), "Keep local file\n", "utf8");
	await writeFile(
		configPath,
		`# keep this project comment
version: "1"
providers:
  qoder:
    api_key: test-key
defaults:
  provider: qoder
environments:
  sandbox:
    config:
      type: cloud
vaults:
  secrets:
    display_name: Secrets
    credentials:
      - name: bearer
        type: static_bearer
        mcp_server_url: https://example.com/mcp
        access_token: literal-secret
memory_stores:
  memory:
    description: Existing memory
    entries:
      - key: note
        content: inline note
skills:
  helper:
    source: https://example.com/helper.zip
files:
  input:
    source: ./keep.txt
agents:
  assistant:
    description: Existing Agent # keep agent comment
    model: ultimate
    instructions: ./instructions.md
    environment: sandbox
    skills: [helper]
    vault: secrets
    memory_stores: [memory]
${
	options.deployment === false
		? ""
		: `deployments:\n  daily:\n    agent: assistant\n    environment: sandbox\n    vaults: [secrets]\n    memory_stores: [memory]\n    resources:\n      - type: memory_store\n        memory_store: memory\n    initial_events:\n      - type: user.message\n        content: run\n`
}`,
		"utf8",
	);
	const manager = new ProjectRuntimeManager(configPath);
	managers.push(manager);
	await manager.ensureStarted();
	if (manager.getSnapshot().status !== "valid") {
		throw new Error(JSON.stringify(manager.getSnapshot().diagnostics));
	}
	return { directory, configPath, manager };
}

async function managerFixture(source: string): Promise<ProjectRuntimeManager> {
	const directory = await mkdtemp(join(tmpdir(), "openagentpack-declarations-"));
	directories.push(directory);
	const configPath = join(directory, "agents.yaml");
	await writeFile(configPath, source, "utf8");
	const manager = new ProjectRuntimeManager(configPath);
	managers.push(manager);
	await manager.ensureStarted();
	if (manager.getSnapshot().status !== "valid") {
		throw new Error(JSON.stringify(manager.getSnapshot().diagnostics));
	}
	return manager;
}
