import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { resolveProjectConfig } from "@openagentpack/sdk";
import {
	commitProjectBuild,
	createDirectoryWorkspaceVersionService,
	getProjectBuildStatus,
	initializeDirectoryProject,
	inspectDirectoryProject,
	planProjectPublish,
	previewProjectBuild,
	resolveDirectoryProjectRuntime,
} from "../src/index.ts";
import { applyVaultSecretMigration, planVaultSecretMigration, readProjectEnvironment } from "../src/vault-secrets.ts";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture(value: string | number = "test-private-token", shared = false) {
	const root = await mkdtemp(resolve(tmpdir(), "agents-vault-build-"));
	directories.push(root);
	await initializeDirectoryProject({ projectRoot: root });
	const vaultPath = shared ? "resources/vaults/secrets/vault.json" : "agents/assistant/vaults/secrets/vault.json";
	await mkdir(resolve(root, vaultPath, ".."), { recursive: true });
	const metadata = {
		id: "secrets",
		display_name: "Secrets",
		credentials: [{ name: "service", type: "environment_variable", secret_name: "SERVICE_TOKEN", secret_value: value }],
	};
	await writeFile(resolve(root, vaultPath), `${JSON.stringify(metadata, null, 2)}\n`);
	const agent = JSON.parse(await readFile(resolve(root, "agents/assistant/agent.json"), "utf8"));
	agent.vault = "secrets";
	await writeFile(resolve(root, "agents/assistant/agent.json"), JSON.stringify(agent));
	return { root, vaultPath, metadata };
}

async function build(root: string) {
	const preview = await previewProjectBuild(root);
	expect(preview.can_build).toBe(true);
	return commitProjectBuild({ projectRoot: root, baseRevision: preview.project_revision });
}

describe("Vault Build secret migration", () => {
	test("Preview is read-only and safe; Build externalizes secrets with private permissions and is idempotent", async () => {
		const { root, vaultPath } = await fixture();
		await chmod(resolve(root, vaultPath), 0o640);
		const original = await readFile(resolve(root, vaultPath), "utf8");
		const preview = await previewProjectBuild(root);
		expect(preview.can_build).toBe(true);
		expect(JSON.stringify(preview)).not.toContain("test-private-token");
		expect(preview.source_files.some((file) => Buffer.from(file.content).includes("test-private-token"))).toBe(false);
		expect(preview.after_yaml).toContain("${AGENTS_VAULT_");
		expect(await readFile(resolve(root, vaultPath), "utf8")).toBe(original);
		await expect(stat(resolve(root, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
		// Preview must not accidentally make plaintext source eligible for versioning.
		await expect(createDirectoryWorkspaceVersionService(root).prepareVersion()).rejects.toThrow("sensitive field");

		const built = await commitProjectBuild({ projectRoot: root, baseRevision: preview.project_revision });
		const env = await readProjectEnvironment(root);
		expect(Object.values(env)).toEqual(["test-private-token"]);
		const variable = Object.keys(env)[0]!;
		expect(JSON.parse(await readFile(resolve(root, vaultPath), "utf8")).credentials[0].secret_value).toBe(
			`\${${variable}}`,
		);
		expect((await stat(resolve(root, ".env"))).mode & 0o777).toBe(0o600);
		expect((await stat(resolve(root, vaultPath))).mode & 0o777).toBe(0o640);
		expect(built.project_revision).not.toBe(preview.project_revision);
		expect((await getProjectBuildStatus(root)).stale).toBe(false);
		const envContent = await readFile(resolve(root, ".env"), "utf8");
		expect((await build(root)).project_revision).toBe(built.project_revision);
		expect(await readFile(resolve(root, ".env"), "utf8")).toBe(envContent);
		expect(await readFile(resolve(root, ".openagentpack/build/agents.yaml"), "utf8")).not.toContain(
			"test-private-token",
		);

		const versions = createDirectoryWorkspaceVersionService(root);
		const prepared = await versions.prepareVersion();
		try {
			expect(
				prepared.snapshot.files.some(
					(file) => file.path === ".env" || Buffer.from(file.content).includes("test-private-token"),
				),
			).toBe(false);
		} finally {
			await versions.releasePrepared(prepared);
		}
	});

	test("preserves existing dotenv text and avoids conflicting dotenv and process variables", async () => {
		const { root } = await fixture();
		const preview = await previewProjectBuild(root);
		const variable = /\$\{(AGENTS_VAULT_[A-Z0-9_]+)\}/.exec(preview.after_yaml)![1]!;
		const existing = `# Keep this comment\nUNRELATED='keep # exactly'\n${variable}='older-value'`;
		await writeFile(resolve(root, ".env"), existing, { mode: 0o644 });
		process.env[`${variable}_2`] = "inherited-value";
		try {
			await build(root);
			expect(await readFile(resolve(root, ".env"), "utf8")).toStartWith(`${existing}\n`);
			expect(await readProjectEnvironment(root)).toMatchObject({
				UNRELATED: "keep # exactly",
				[variable]: "older-value",
				[`${variable}_3`]: "test-private-token",
			});
			expect(process.env[`${variable}_2`]).toBe("inherited-value");
		} finally {
			delete process.env[`${variable}_2`];
		}
	});

	test("supports shared Vaults, numeric secrets, and literal multiline/quote characters without environment pollution", async () => {
		for (const secret of [123456, "a # $TOKEN \\ path", "first\nsecond:'quoted'\nlast", "both'and\"quotes"]) {
			const { root, vaultPath } = await fixture(secret, true);
			await writeFile(
				resolve(root, ".env"),
				"DASHSCOPE_API_KEY='test-provider-key'\nBAILIAN_BASE_URL='https://example.invalid/api/v1/agentstudio'\n",
			);
			await build(root);
			const reference = JSON.parse(await readFile(resolve(root, vaultPath), "utf8")).credentials[0]
				.secret_value as string;
			const variable = reference.slice(2, -1);
			expect(process.env[variable]).toBeUndefined();
			const runtime = await resolveDirectoryProjectRuntime(root);
			expect(runtime.config.vaults?.secrets?.credentials[0]).toMatchObject({ secret_value: String(secret) });
			// The generated YAML is interpolated as parsed scalar values, not raw YAML text.
			const loaded = await resolveProjectConfig(resolve(root, ".openagentpack/build/agents.yaml"), {
				environment: await readProjectEnvironment(root),
			});
			expect(loaded.config.vaults?.secrets?.credentials[0]).toMatchObject({ secret_value: String(secret) });
			expect(process.env[variable]).toBeUndefined();
		}
	});

	test("Publish passes the project-root environment to the host resolver without changing process.env", async () => {
		const { root } = await fixture();
		await build(root);
		await expect(
			planProjectPublish(root, {
				resolveBuild: async (_path, options) => {
					const variable = Object.keys(options!.environment!)[0]!;
					expect(options!.environment![variable]).toBe("test-private-token");
					expect(process.env[variable]).toBeUndefined();
					throw new Error("test stops before remote operations");
				},
			}),
		).rejects.toThrow("test stops before remote operations");
	});

	test("leaves existing environment references untouched without creating .env", async () => {
		const { root, vaultPath } = await fixture(`\${EXISTING_SECRET}`);
		const original = await readFile(resolve(root, vaultPath), "utf8");
		await build(root);
		expect(await readFile(resolve(root, vaultPath), "utf8")).toBe(original);
		await expect(stat(resolve(root, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("invalid project, invalid JSON, unsupported secret encoding, and unsafe .env do not write secrets", async () => {
		const { root, vaultPath, metadata } = await fixture();
		for (const value of [
			"invalid JSON with test-private-token",
			JSON.stringify({ ...metadata, display_name: false }),
			JSON.stringify({ ...metadata, credentials: [{ ...metadata.credentials[0], type: "typo" }] }),
			JSON.stringify({
				...metadata,
				credentials: [{ ...metadata.credentials[0], secret_value: { invalid: "test-private-token" } }],
			}),
			JSON.stringify({
				...metadata,
				credentials: [{ ...metadata.credentials[0], secret_value: "all'quote\"styles`" }],
			}),
		]) {
			await writeFile(resolve(root, vaultPath), value);
			const preview = await previewProjectBuild(root);
			expect(preview.can_build).toBe(false);
			expect(JSON.stringify(preview)).not.toContain("test-private-token");
			expect(preview.source_files.some((file) => Buffer.from(file.content).includes("test-private-token"))).toBe(false);
			await expect(commitProjectBuild({ projectRoot: root, baseRevision: preview.project_revision })).rejects.toThrow();
			expect(await readFile(resolve(root, vaultPath), "utf8")).toBe(value);
			await expect(stat(resolve(root, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
		}
		await writeFile(resolve(root, vaultPath), JSON.stringify(metadata));
		const outside = resolve(root, "unrelated.txt");
		await writeFile(outside, "unchanged");
		await symlink(outside, resolve(root, ".env"));
		expect((await previewProjectBuild(root)).can_build).toBe(false);
		expect(await readFile(outside, "utf8")).toBe("unchanged");
	});

	test("rejects stale source revision and dotenv/source changes between migration planning and commit", async () => {
		const { root, vaultPath } = await fixture();
		const raw = await inspectDirectoryProject(root);
		const migration = await planVaultSecretMigration(root, raw.source_files);
		await writeFile(resolve(root, ".env"), "USER_EDIT='retain'\n");
		await expect(applyVaultSecretMigration(root, raw.source_files, migration)).rejects.toThrow(".env changed");
		const next = await planVaultSecretMigration(root, raw.source_files);
		await writeFile(resolve(root, vaultPath), '{"id":"edited"}');
		await expect(applyVaultSecretMigration(root, raw.source_files, next)).rejects.toThrow("Vault source changed");
		await expect(commitProjectBuild({ projectRoot: root, baseRevision: raw.project_revision })).rejects.toThrow(
			"source changed",
		);
		expect(await readFile(resolve(root, ".env"), "utf8")).toBe("USER_EDIT='retain'\n");
	});
});
