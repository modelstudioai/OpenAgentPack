import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeDirectoryProject } from "@openagentpack/project-workspace";
import { ProjectRuntimeManager } from "../src/services/project-manager";
import {
	commitProjectVersionAfterApply,
	getProjectVersioningStatus,
	listProjectVersions,
	prepareProjectVersionForApply,
	previewProjectVersion,
	releaseProjectVersionAfterApply,
	restoreProjectVersion,
	setProjectVersioning,
} from "../src/services/project-versions";

const directories: string[] = [];
const managers: ProjectRuntimeManager[] = [];
process.env.DASHSCOPE_API_KEY ??= "test-bailian-api-key";
process.env.BAILIAN_BASE_URL ??= "https://example.com/api/v1/agentstudio";

afterEach(async () => {
	for (const manager of managers.splice(0)) manager.close();
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("Workbench directory project versions", () => {
	test("project init enables one shared snapshot store with a baseline", async () => {
		const fixture = await projectFixture();
		const status = await getProjectVersioningStatus(fixture.manager);

		expect(status.initialized).toBe(true);
		expect(status.enabled).toBe(true);
		expect(status.store_root).toBe(join(fixture.root, ".openagentpack/versions/project"));
		expect(status.head_version).toMatch(/^[a-f0-9]{64}$/);
		expect(status.source_versioned).toBe(true);
		expect((await listProjectVersions({}, fixture.manager)).versions[0]?.message).toBe("Initialize project");
	});

	test("records complete directory source and restores it without moving head or State", async () => {
		const fixture = await projectFixture();
		const instructionsPath = join(fixture.root, "agents/assistant/instructions.md");
		const binaryPath = join(fixture.root, "assets/icon.bin");
		const statePath = join(fixture.root, ".openagentpack/state.json");
		await writeFile(statePath, '{"remote":"latest"}\n');
		await chmod(instructionsPath, 0o640);
		const baseline = (await getProjectVersioningStatus(fixture.manager)).head_version!;

		await writeFile(instructionsPath, "Second instructions\n");
		await mkdir(join(fixture.root, "assets"));
		await writeFile(binaryPath, new Uint8Array([0, 1, 2, 3]));
		await fixture.manager.refreshAfterSourceMutation();
		const prepared = await prepareProjectVersionForApply({ baseRevision: fixture.revision() }, fixture.manager);
		const committed = await commitProjectVersionAfterApply(prepared, "Publish second", fixture.manager);
		const second = committed.version!.version_id;

		const preview = await previewProjectVersion(
			{ versionId: baseline, baseRevision: fixture.revision(), baseHeadVersion: second },
			fixture.manager,
		);
		expect(preview.changes).toContainEqual(
			expect.objectContaining({
				path: "agents/assistant/instructions.md",
				change: "update",
				before: "Second instructions\n",
				after: "You are a helpful assistant.\n",
			}),
		);
		expect(preview.changes).toContainEqual(
			expect.objectContaining({ path: "assets/icon.bin", change: "delete", binary: true }),
		);

		const revision = fixture.revision();
		const restored = await restoreProjectVersion(
			{ versionId: baseline, baseRevision: revision, baseHeadVersion: second },
			fixture.manager,
		);
		expect(restored.new_revision).not.toBe(revision);
		expect(await readFile(instructionsPath, "utf8")).toBe("You are a helpful assistant.\n");
		expect(await stat(binaryPath).catch(() => null)).toBeNull();
		expect((await getProjectVersioningStatus(fixture.manager)).head_version).toBe(second);
		expect(await readFile(statePath, "utf8")).toBe('{"remote":"latest"}\n');
		expect((await stat(instructionsPath)).mode & 0o777).toBe(0o644);
	});

	test("disabled versioning still leases the directory during Publish without creating versions", async () => {
		const fixture = await projectFixture();
		const baseline = (await getProjectVersioningStatus(fixture.manager)).head_version!;
		await setProjectVersioning({ baseRevision: fixture.revision(), enabled: false }, fixture.manager);
		await writeFile(join(fixture.root, "agents/assistant/instructions.md"), "Changed while disabled\n");
		await fixture.manager.refreshAfterSourceMutation();

		const prepared = await prepareProjectVersionForApply({ baseRevision: fixture.revision() }, fixture.manager);
		await expect(
			setProjectVersioning({ baseRevision: fixture.revision(), enabled: true }, fixture.manager),
		).rejects.toThrow(/busy/i);
		const committed = await commitProjectVersionAfterApply(prepared, "Disabled Publish", fixture.manager);
		expect(committed.version).toBeNull();
		expect(committed.versioning.head_version).toBe(baseline);
		expect(committed.versioning.enabled).toBe(false);
	});

	test("reuses the current head for a no-op Publish and rejects stale or abbreviated identities", async () => {
		const fixture = await projectFixture();
		const status = await getProjectVersioningStatus(fixture.manager);
		const prepared = await prepareProjectVersionForApply({ baseRevision: fixture.revision() }, fixture.manager);
		const committed = await commitProjectVersionAfterApply(prepared, "No-op Publish", fixture.manager);
		expect(committed.version).toBeNull();
		expect(committed.versioning.head_version).toBe(status.head_version);

		await expect(
			previewProjectVersion(
				{
					versionId: status.head_version!.slice(0, 12),
					baseRevision: fixture.revision(),
					baseHeadVersion: status.head_version!,
				},
				fixture.manager,
			),
		).rejects.toThrow(/full 64-character/i);
		await expect(
			setProjectVersioning({ baseRevision: "stale", enabled: false }, fixture.manager),
		).rejects.toMatchObject({ status: 409 });
	});

	test("releases the cross-process mutation lease when Publish preparation is abandoned", async () => {
		const fixture = await projectFixture();
		const prepared = await prepareProjectVersionForApply({ baseRevision: fixture.revision() }, fixture.manager);
		await releaseProjectVersionAfterApply(prepared, fixture.manager);
		const disabled = await setProjectVersioning({ baseRevision: fixture.revision(), enabled: false }, fixture.manager);
		expect(disabled.enabled).toBe(false);
	});
});

async function projectFixture(): Promise<{
	root: string;
	manager: ProjectRuntimeManager;
	revision(): string;
}> {
	const root = await mkdtemp(join(tmpdir(), "openagentpack-versions-"));
	directories.push(root);
	await initializeDirectoryProject({ projectRoot: root });
	const manager = new ProjectRuntimeManager(root);
	managers.push(manager);
	await manager.ensureStarted();
	if (manager.getSnapshot().status !== "valid") throw new Error(JSON.stringify(manager.getSnapshot().diagnostics));
	return { root, manager, revision: () => manager.getSnapshot().revision! };
}
