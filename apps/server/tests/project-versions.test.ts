import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

afterEach(async () => {
	for (const manager of managers.splice(0)) manager.close();
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("Workbench project versions", () => {
	test("stays uninitialized until the shared switch is explicitly enabled", async () => {
		const fixture = await projectFixture();

		const initial = await getProjectVersioningStatus(fixture.manager);
		expect(initial.initialized).toBe(false);
		expect(initial.enabled).toBe(false);
		expect(await prepareProjectVersionForApply({ baseRevision: fixture.revision() }, fixture.manager)).toBeNull();

		const enabled = await setProjectVersioning({ baseRevision: fixture.revision(), enabled: true }, fixture.manager);
		expect(enabled.store_root).toBe(join(await realpath(fixture.root), ".openagentpack", "versions"));
		expect(enabled.head_version).not.toBeNull();
		expect(enabled.source_versioned).toBe(true);
		expect((await listProjectVersions({}, fixture.manager)).versions[0]?.message).toBe("Enable local versions");
	});

	test("versions successful Apply content and restores YAML without changing State or head", async () => {
		const fixture = await projectFixture();
		await chmod(fixture.configPath, 0o640);
		const statePath = join(fixture.root, "agents.state.json");
		await writeFile(statePath, '{"remote":"latest"}\n');
		const enabled = await setProjectVersioning({ baseRevision: fixture.revision(), enabled: true }, fixture.manager);
		const firstVersion = enabled.head_version!;

		await writeFile(fixture.configPath, projectYaml("Second instructions"));
		await fixture.manager.refreshAfterSourceMutation();
		const prepared = await prepareProjectVersionForApply({ baseRevision: fixture.revision() }, fixture.manager);
		const second = await commitProjectVersionAfterApply(prepared, "Apply second", fixture.manager);
		const secondVersion = second.version!.version_id;
		const revision = fixture.revision();
		const preview = await previewProjectVersion(
			{ versionId: firstVersion, baseRevision: revision, baseHeadVersion: secondVersion },
			fixture.manager,
		);
		expect(preview.before_yaml).toContain("Second instructions");
		expect(preview.after_yaml).toContain("First instructions");

		const restored = await restoreProjectVersion(
			{ versionId: firstVersion, baseRevision: revision, baseHeadVersion: secondVersion },
			fixture.manager,
		);
		expect(restored.new_revision).not.toBe(revision);
		expect(await readFile(fixture.configPath, "utf8")).toContain("First instructions");
		expect((await getProjectVersioningStatus(fixture.manager)).head_version).toBe(secondVersion);
		expect(await readFile(statePath, "utf8")).toBe('{"remote":"latest"}\n');
		expect((await stat(fixture.configPath)).mode & 0o777).toBe(0o640);
	});

	test("restores a valid version when current YAML is invalid and redacts current literals", async () => {
		const fixture = await projectFixture();
		const enabled = await setProjectVersioning({ baseRevision: fixture.revision(), enabled: true }, fixture.manager);
		await writeFile(fixture.configPath, "version: [\napi_key: literal-do-not-leak\n");
		await fixture.manager.refreshAfterSourceMutation();
		const invalidRevision = fixture.revision();

		const restored = await restoreProjectVersion(
			{
				versionId: enabled.head_version!,
				baseRevision: invalidRevision,
				baseHeadVersion: enabled.head_version!,
			},
			fixture.manager,
		);
		expect(restored.new_revision).not.toBe(invalidRevision);
		expect(fixture.manager.getSnapshot().status).toBe("valid");
		expect(JSON.stringify(restored)).not.toContain("literal-do-not-leak");
	});

	test("shares one switch and never re-enables it during Apply", async () => {
		const fixture = await projectFixture();
		await setProjectVersioning({ baseRevision: fixture.revision(), enabled: true }, fixture.manager);
		const disabled = await setProjectVersioning({ baseRevision: fixture.revision(), enabled: false }, fixture.manager);
		expect(disabled.enabled).toBe(false);
		await writeFile(fixture.configPath, projectYaml("Changed while disabled"));
		await fixture.manager.refreshAfterSourceMutation();
		expect(await prepareProjectVersionForApply({ baseRevision: fixture.revision() }, fixture.manager)).toBeNull();
		expect((await getProjectVersioningStatus(fixture.manager)).enabled).toBe(false);
	});

	test("does not create empty Apply versions and releases the mutation lease", async () => {
		const fixture = await projectFixture();
		const enabled = await setProjectVersioning({ baseRevision: fixture.revision(), enabled: true }, fixture.manager);
		const unchangedPrepared = await prepareProjectVersionForApply(
			{ baseRevision: fixture.revision() },
			fixture.manager,
		);
		const reused = await commitProjectVersionAfterApply(unchangedPrepared, "No-op Apply", fixture.manager);
		expect(reused.version).toBeNull();
		expect(reused.versioning.head_version).toBe(enabled.head_version);

		await writeFile(fixture.configPath, projectYaml("Changed instructions"));
		await fixture.manager.refreshAfterSourceMutation();
		const prepared = await prepareProjectVersionForApply({ baseRevision: fixture.revision() }, fixture.manager);
		await expect(
			setProjectVersioning({ baseRevision: fixture.revision(), enabled: false }, fixture.manager),
		).rejects.toMatchObject({ status: 409 });
		await releaseProjectVersionAfterApply(prepared, fixture.manager);
		const disabled = await setProjectVersioning({ baseRevision: fixture.revision(), enabled: false }, fixture.manager);
		expect(disabled.enabled).toBe(false);
	});

	test("rejects sensitive literals, stale identities, live locks, and abbreviated IDs", async () => {
		const fixture = await projectFixture();
		await writeFile(
			fixture.configPath,
			projectYaml("Instructions").replace("qoder: {}", "qoder:\n    api_key: literal-secret"),
		);
		await fixture.manager.refreshAfterSourceMutation();
		await expect(
			setProjectVersioning({ baseRevision: fixture.revision(), enabled: true }, fixture.manager),
		).rejects.toMatchObject({ status: 422 });

		await writeFile(fixture.configPath, projectYaml("Safe"));
		await fixture.manager.refreshAfterSourceMutation();
		await expect(setProjectVersioning({ baseRevision: "stale", enabled: true }, fixture.manager)).rejects.toMatchObject(
			{ status: 409 },
		);
		const enabled = await setProjectVersioning({ baseRevision: fixture.revision(), enabled: true }, fixture.manager);
		await expect(
			previewProjectVersion(
				{
					versionId: enabled.head_version!.slice(0, 12),
					baseRevision: fixture.revision(),
					baseHeadVersion: enabled.head_version!,
				},
				fixture.manager,
			),
		).rejects.toMatchObject({ status: 400 });

		const lockPath = join(enabled.store_root, "mutation.lock");
		await mkdir(lockPath);
		await writeFile(
			join(lockPath, "lease.json"),
			JSON.stringify({ pid: process.pid, token: "live", kind: "apply", created_at: new Date().toISOString() }),
		);
		await expect(
			setProjectVersioning({ baseRevision: fixture.revision(), enabled: false }, fixture.manager),
		).rejects.toMatchObject({ status: 409 });
	});
});

async function projectFixture(): Promise<{
	root: string;
	configPath: string;
	manager: ProjectRuntimeManager;
	revision(): string;
}> {
	const root = await mkdtemp(join(tmpdir(), "openagentpack-versions-"));
	directories.push(root);
	const configPath = join(root, "agents.yaml");
	await writeFile(configPath, projectYaml("First instructions"));
	const manager = new ProjectRuntimeManager(configPath);
	managers.push(manager);
	await manager.ensureStarted();
	if (manager.getSnapshot().status !== "valid") throw new Error(JSON.stringify(manager.getSnapshot().diagnostics));
	return { root, configPath, manager, revision: () => manager.getSnapshot().revision! };
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
