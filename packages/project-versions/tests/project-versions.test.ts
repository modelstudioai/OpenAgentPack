import { afterEach, describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	commitPreparedProjectVersion,
	createProjectVersionService,
	enableProjectVersioning,
	getProjectVersionStatus,
	prepareProjectVersion,
	previewProjectVersion,
	releasePreparedProjectVersion,
	restoreProjectVersion,
} from "../src/index";

const directories: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("shared project versions", () => {
	test("does not create storage until the shared switch is explicitly enabled", async () => {
		const root = await temporaryDirectory();
		const configPath = join(root, "agents.yaml");
		await writeFile(configPath, projectYaml("Initial"));

		const status = await getProjectVersionStatus(configPath);

		expect(status.initialized).toBe(false);
		expect(status.enabled).toBe(false);
		expect(status.store_root).toBe(join(await realpath(root), ".openagentpack", "versions"));
		await expect(access(status.store_root)).rejects.toThrow();
		expect(await prepareProjectVersion(configPath, await readFile(configPath, "utf8"))).toBeNull();
	});

	test("stores head metadata, immutable entries, and full content-addressed YAML blobs", async () => {
		const root = await temporaryDirectory();
		const configPath = join(root, "agents.yaml");
		const source = projectYaml("First private instructions");
		await writeFile(configPath, source);

		const enabled = await enableProjectVersioning(configPath, "Initial local version");

		expect(enabled.versioning.enabled).toBe(true);
		expect(enabled.version?.message).toBe("Initial local version");
		const storeRoot = enabled.versioning.store_root;
		const storeSource = await readFile(join(storeRoot, "store.json"), "utf8");
		expect(storeSource).not.toContain("First private instructions");
		expect(Object.keys(JSON.parse(storeSource) as Record<string, unknown>).sort()).toEqual([
			"config_path",
			"enabled",
			"head_version",
			"schema_version",
		]);
		const entrySource = await readFile(join(storeRoot, "entries", `${enabled.version!.version_id}.json`), "utf8");
		expect(entrySource).not.toContain("First private instructions");
		const blobPath = join(storeRoot, "blobs", `${enabled.version!.source_hash}.yaml`);
		expect(await readFile(blobPath, "utf8")).toBe(source);
		expect(await readFile(join(storeRoot, ".gitignore"), "utf8")).toBe("*\n");
		expect((await stat(blobPath)).mode & 0o777).toBe(0o600);
	});

	test("keeps the version store invisible to an enclosing Git worktree", async () => {
		const root = await temporaryDirectory();
		const configPath = join(root, "agents.yaml");
		await writeFile(configPath, projectYaml("Initial"));
		await execFileAsync("git", ["init", "--initial-branch", "main"], { cwd: root });
		await execFileAsync("git", ["add", "--", "agents.yaml"], { cwd: root });
		const before = await execFileAsync("git", ["status", "--porcelain=v1"], { cwd: root });

		await enableProjectVersioning(configPath, "Baseline");

		const after = await execFileAsync("git", ["status", "--porcelain=v1"], { cwd: root });
		expect(after.stdout).toBe(before.stdout);
		expect(after.stdout).not.toContain(".openagentpack");
	});

	test("creates versions only for changed YAML and binds pagination to the head", async () => {
		const root = await temporaryDirectory();
		const configPath = join(root, "agents.yaml");
		const firstSource = projectYaml("First");
		await writeFile(configPath, firstSource);
		const service = createProjectVersionService({ configPath });
		const baseline = await service.enable("Baseline");

		const unchanged = await service.prepareVersion(firstSource);
		expect(unchanged?.needsVersion).toBe(false);
		expect(await service.commitPrepared(unchanged!, "No empty version")).toBeNull();

		const secondSource = projectYaml("Second");
		await writeFile(configPath, secondSource);
		const prepared = await service.prepareVersion(secondSource);
		const second = await service.commitPrepared(prepared!, "Apply agents.yaml");

		expect(second?.version_id).not.toBe(baseline.version?.version_id);
		const firstPage = await service.listVersions({ limit: 1 });
		expect(firstPage.versions.map((version) => version.message)).toEqual(["Apply agents.yaml"]);
		expect(firstPage.next_cursor).not.toBeNull();
		await writeFile(configPath, projectYaml("Third"));
		const thirdPrepared = await service.prepareVersion(await readFile(configPath, "utf8"));
		await service.commitPrepared(thirdPrepared!, "Third");
		await expect(service.listVersions({ cursor: firstPage.next_cursor! })).rejects.toThrow("Version history changed");
		expect((await service.status()).source_status).toBe("clean");
	});

	test("restores an old blob without moving head, then creates a forward version reusing that blob", async () => {
		const root = await temporaryDirectory();
		const configPath = join(root, "agents.yaml");
		await writeFile(configPath, projectYaml("Version one"));
		await chmod(configPath, 0o640);
		const enabled = await enableProjectVersioning(configPath, "Version one");
		const firstVersion = enabled.version!;
		const secondSource = projectYaml("Version two");
		await writeFile(configPath, secondSource);
		const secondPrepared = await prepareProjectVersion(configPath, secondSource);
		const second = await commitPreparedProjectVersion(secondPrepared!, "Version two");

		const preview = await previewProjectVersion(configPath, firstVersion.version_id);
		await restoreProjectVersion(configPath, firstVersion.version_id, {
			headVersion: preview.base_head_version,
			sourceRevision: preview.base_source_revision,
		});
		expect((await getProjectVersionStatus(configPath)).head_version).toBe(second!.version_id);
		expect((await getProjectVersionStatus(configPath)).source_status).toBe("modified");
		expect((await stat(configPath)).mode & 0o777).toBe(0o640);

		const forwardPrepared = await prepareProjectVersion(configPath, await readFile(configPath, "utf8"));
		const forward = await commitPreparedProjectVersion(forwardPrepared!, "Restore forward");
		expect(forward?.parent_version).toBe(second!.version_id);
		expect(forward?.source_hash).toBe(firstVersion.source_hash);
		const blobs = await readdir(join(root, ".openagentpack", "versions", "blobs"));
		expect(blobs).toHaveLength(2);
	});

	test("holds a cross-host mutation lease and recovers it only for a dead process", async () => {
		const root = await temporaryDirectory();
		const configPath = join(root, "agents.yaml");
		const source = projectYaml("Version one");
		await writeFile(configPath, source);
		await enableProjectVersioning(configPath, "Version one");
		const prepared = await prepareProjectVersion(configPath, source);
		await expect(enableProjectVersioning(configPath, "Concurrent")).rejects.toThrow("Another process");
		await releasePreparedProjectVersion(prepared);

		const lockPath = join(root, ".openagentpack", "versions", "mutation.lock");
		await mkdir(lockPath);
		await writeFile(
			join(lockPath, "lease.json"),
			JSON.stringify({ pid: 2_147_483_647, token: "dead", kind: "apply", created_at: new Date().toISOString() }),
		);
		const recovered = await enableProjectVersioning(configPath, "Recovered");
		expect(recovered.version).toBeNull();
	});

	test("fails closed for stale identities and missing immutable objects", async () => {
		const root = await temporaryDirectory();
		const configPath = join(root, "agents.yaml");
		await writeFile(configPath, projectYaml("Version one"));
		const enabled = await enableProjectVersioning(configPath, "Version one");
		const preview = await previewProjectVersion(configPath, enabled.version!.version_id);

		await expect(
			restoreProjectVersion(configPath, enabled.version!.version_id, {
				headVersion: "0".repeat(64),
				sourceRevision: preview.base_source_revision,
			}),
		).rejects.toThrow("current local version changed");

		await rm(join(root, ".openagentpack", "versions", "blobs", `${enabled.version!.source_hash}.yaml`));
		await expect(previewProjectVersion(configPath, enabled.version!.version_id)).rejects.toThrow("blob");
	});
});

async function temporaryDirectory(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "openagentpack-project-versions-"));
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
