import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	commitProjectBuild,
	getProjectBuildStatus,
	initializeDirectoryProject,
} from "@openagentpack/project-workspace";
import { ProjectRuntimeManager } from "../src/services/project-manager";

const directories: string[] = [];
const managers: ProjectRuntimeManager[] = [];
process.env.QODER_PAT ??= "test-qoder-pat";

afterEach(async () => {
	for (const manager of managers.splice(0)) manager.close();
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("ProjectRuntimeManager", () => {
	test("surfaces a missing directory project and watches its root", async () => {
		const directory = await temporaryDirectory("missing");
		const manager = trackManager(new ProjectRuntimeManager(directory));

		await manager.ensureStarted();
		const summary = await manager.getSummary();
		expect(summary.status).toBe("missing");
		expect(summary.diagnostics[0]?.code).toBe("project.config.missing");
		expect(summary.config_file).toBe(join(directory, ".openagentpack/build/agents.yaml"));
	});

	test("loads directory source and changes revision when instructions change", async () => {
		const directory = await initializedProject("watch");
		const manager = trackManager(new ProjectRuntimeManager(directory));

		await manager.ensureStarted();
		const first = manager.getSnapshot();
		expect(first.status).toBe("valid");
		expect(first.config?.agents.assistant).toBeDefined();

		await writeFile(join(directory, "agents/assistant/instructions.md"), "Second instruction\n");
		await manager.refreshAfterSourceMutation();
		const second = manager.getSnapshot();
		expect(second.status).toBe("valid");
		expect(second.revision).not.toBe(first.revision);
	});

	test("marks the generated Build stale after any source-tree edit", async () => {
		const directory = await initializedProject("build-stale");
		const manager = trackManager(new ProjectRuntimeManager(directory));
		await manager.ensureStarted();
		await commitProjectBuild({ projectRoot: directory, baseRevision: manager.getSnapshot().revision! });
		await manager.refreshAfterSourceMutation();
		expect((await getProjectBuildStatus(directory)).stale).toBe(false);

		await writeFile(join(directory, "notes.md"), "A manually edited project file.\n");
		manager.scheduleReload();
		await waitFor(() => manager.getSnapshot().sourcePaths.includes(join(directory, "notes.md")));
		const build = await getProjectBuildStatus(directory);
		expect(build.stale).toBe(true);
		expect(build.reasons).toContain("Project source changed after the last Build.");
	});

	test("keeps parsed Agents visible when a cross-reference is invalid", async () => {
		const directory = await initializedProject("invalid-reference");
		await writeFile(
			join(directory, "agents/assistant/agent.json"),
			`${JSON.stringify({ name: "Assistant", model: "qwen-plus", environment: "missing" }, null, 2)}\n`,
		);
		const manager = trackManager(new ProjectRuntimeManager(directory));

		await manager.ensureStarted();
		const snapshot = manager.getSnapshot();
		expect(snapshot.status).toBe("invalid");
		expect(snapshot.config?.agents.assistant).toBeDefined();
		expect(snapshot.diagnostics.some((diagnostic) => diagnostic.code === "config.agent.environment.unknown")).toBe(
			true,
		);
		expect(() => manager.requireRuntimeInput()).toThrow(/directory project is invalid/i);
	});

	test("maintains a source revision while project JSON is syntactically invalid", async () => {
		const directory = await initializedProject("invalid-json");
		const manager = trackManager(new ProjectRuntimeManager(directory));
		await manager.ensureStarted();

		await writeFile(join(directory, "project.json"), "{\n");
		await manager.refreshAfterSourceMutation();
		const firstRevision = manager.getSnapshot().revision;
		expect(manager.getSnapshot().status).toBe("invalid");
		expect(firstRevision).toBeString();

		await writeFile(join(directory, "project.json"), '{"version":\n');
		await manager.refreshAfterSourceMutation();
		expect(manager.getSnapshot().revision).not.toBe(firstRevision);
	});
});

async function initializedProject(name: string): Promise<string> {
	const directory = await temporaryDirectory(name);
	await initializeDirectoryProject({ projectRoot: directory, provider: "qoder" });
	return directory;
}

async function temporaryDirectory(name: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), `openagentpack-project-${name}-`));
	directories.push(directory);
	return directory;
}

function trackManager(manager: ProjectRuntimeManager): ProjectRuntimeManager {
	managers.push(manager);
	return manager;
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await Bun.sleep(25);
	}
	throw new Error("Timed out waiting for directory project reload");
}
