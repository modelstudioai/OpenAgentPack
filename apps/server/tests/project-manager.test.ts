import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectRuntimeManager } from "../src/services/project-manager";

const managers: ProjectRuntimeManager[] = [];

afterEach(() => {
	for (const manager of managers.splice(0)) manager.close();
});

describe("ProjectRuntimeManager", () => {
	test("surfaces a missing agents.yaml and watches its parent directory", async () => {
		const directory = await mkdtemp(join(tmpdir(), "openagentpack-project-missing-"));
		const manager = new ProjectRuntimeManager(join(directory, "agents.yaml"));
		managers.push(manager);

		await manager.ensureStarted();
		const summary = await manager.getSummary();
		expect(summary.status).toBe("missing");
		expect(summary.diagnostics[0]?.code).toBe("project.config.missing");
	});

	test("loads an agents.yaml and changes revision when a referenced instruction changes", async () => {
		const directory = await mkdtemp(join(tmpdir(), "openagentpack-project-watch-"));
		const instructionPath = join(directory, "instructions.md");
		const configPath = join(directory, "agents.yaml");
		await writeFile(instructionPath, "first instruction\n");
		await writeFile(configPath, validProjectYaml());
		const manager = new ProjectRuntimeManager(configPath);
		managers.push(manager);

		await manager.ensureStarted();
		const first = await manager.getSummary();
		expect(first.status).toBe("valid");
		expect(first.agents[0]?.agent.id).toBe("assistant");

		await writeFile(instructionPath, "second instruction\n");
		manager.scheduleReload();
		await Bun.sleep(350);
		const second = await manager.getSummary();
		expect(second.status).toBe("valid");
		expect(second.revision).not.toBe(first.revision);
	});

	test("keeps parsed Agents visible when cross-reference validation is invalid", async () => {
		const directory = await mkdtemp(join(tmpdir(), "openagentpack-project-invalid-"));
		await mkdir(directory, { recursive: true });
		const configPath = join(directory, "agents.yaml");
		await writeFile(join(directory, "instructions.md"), "instructions\n");
		await writeFile(configPath, validProjectYaml().replace("environment: sandbox", "environment: missing-environment"));
		const manager = new ProjectRuntimeManager(configPath);
		managers.push(manager);

		await manager.ensureStarted();
		const summary = await manager.getSummary();
		expect(summary.status).toBe("invalid");
		expect(summary.agents[0]?.agent.id).toBe("assistant");
		expect(summary.diagnostics.some((diagnostic) => diagnostic.code === "config.agent.environment.unknown")).toBe(true);
		expect(() => manager.requireRuntimeInput()).toThrow(/configuration is invalid/i);
	});

	test("recovers when a missing referenced file is created later", async () => {
		const directory = await mkdtemp(join(tmpdir(), "openagentpack-project-missing-reference-"));
		const configPath = join(directory, "agents.yaml");
		await writeFile(configPath, validProjectYaml("./prompts/system.md"));
		const manager = new ProjectRuntimeManager(configPath);
		managers.push(manager);

		await manager.ensureStarted();
		expect(manager.getSnapshot().status).toBe("invalid");

		await mkdir(join(directory, "prompts"));
		await writeFile(join(directory, "prompts/system.md"), "created after Playground startup");
		await waitFor(() => manager.getSnapshot().status === "valid");
		expect(manager.getSnapshot().sourcePaths).toContain(join(directory, "prompts/system.md"));
	});

	test("keeps a content revision while agents.yaml is syntactically invalid", async () => {
		const directory = await mkdtemp(join(tmpdir(), "openagentpack-project-invalid-revision-"));
		const configPath = join(directory, "agents.yaml");
		await writeFile(configPath, "version: [\n");
		const manager = new ProjectRuntimeManager(configPath);
		managers.push(manager);

		await manager.ensureStarted();
		const firstRevision = manager.getSnapshot().revision;
		expect(manager.getSnapshot().status).toBe("invalid");
		expect(firstRevision).toBeString();

		await writeFile(configPath, "version: {\n");
		await manager.refreshAfterSourceMutation();
		expect(manager.getSnapshot().revision).not.toBe(firstRevision);
	});
});

function validProjectYaml(instructions = "./instructions.md"): string {
	return `version: "1"
providers:
  qoder:
    api_key: test-token
defaults:
  provider: qoder
environments:
  sandbox:
    config:
      type: cloud
agents:
  assistant:
    model: ultimate
    instructions: ${instructions}
    environment: sandbox
`;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(25);
	}
	throw new Error("Timed out waiting for project reload");
}
