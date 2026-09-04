import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { resolveProjectConfigFromObject } from "@openagentpack/sdk";
import { parse } from "yaml";
import {
	commitProjectBuild,
	initializeDirectoryProject,
	inspectDirectoryProject,
	locateDirectoryProjectResource,
	planProjectPublish,
	previewProjectBuild,
} from "../src/index.ts";
import { directoryProjectScaffold } from "../src/scaffold.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(): Promise<string> {
	const root = await mkdtemp(resolve(tmpdir(), "agents-project-scaffold-"));
	roots.push(root);
	return root;
}

describe("directory project resource examples", () => {
	test("initializes complete examples but keeps Agent references and Build/Publish unchanged", async () => {
		const root = await fixture();
		await initializeDirectoryProject({ projectRoot: root });
		const expected = directoryProjectScaffold();
		for (const [path, content] of Object.entries(expected))
			expect(await readFile(resolve(root, path), "utf8")).toBe(content);
		expect(Object.keys(expected).filter((path) => path.includes("/_examples/")).length).toBe(10);
		expect(JSON.parse(await readFile(resolve(root, "agents/assistant/agent.json"), "utf8"))).toEqual({
			name: "Assistant",
			model: "qwen3.7-max",
		});
		await expect(stat(resolve(root, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
		await expect(stat(resolve(root, ".openagentpack/build/agents.yaml"))).rejects.toMatchObject({ code: "ENOENT" });
		const preview = await previewProjectBuild(root);
		expect(preview.can_build).toBe(true);
		expect(preview.warnings).toEqual([]);
		expect(preview.organization_moves).toEqual([]);
		expect(preview.after_yaml).not.toContain("example-");
		expect(preview.after_yaml).not.toContain("SERVICE_TOKEN");
		await commitProjectBuild({ projectRoot: root, baseRevision: preview.project_revision });
		const planned = await planProjectPublish(root, {
			refresh: false,
			resolveBuild: async (path) => {
				const config = parse(await readFile(path, "utf8"));
				config.providers = {
					bailian: { api_key: "offline-test", base_url: "https://example.invalid/api/v1/agentstudio" },
				};
				return resolveProjectConfigFromObject(config, { projectName: "scaffold-test", basePath: dirname(path) });
			},
		});
		expect(planned.planned.plan.actions.map((action) => `${action.address.type}.${action.address.name}`)).toEqual([
			"agent.assistant",
		]);
		for (const [type, id] of [
			["environment", "example-env"],
			["vault", "example-vault"],
			["file", "example-file"],
		] as const)
			expect(await locateDirectoryProjectResource(root, type, id)).toBeNull();
		await expect(stat(resolve(root, ".env"))).rejects.toMatchObject({ code: "ENOENT" });
		await expect(stat(resolve(root, ".openagentpack/state.json"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	test("only activates examples after copying them out and declaring Agent references", async () => {
		const root = await fixture();
		await initializeDirectoryProject({ projectRoot: root });
		for (const [directory, resourceId] of [
			["skills", "example-skill"],
			["files", "example-file"],
			["vaults", "example-vault"],
			["environments", "example-env"],
		]) {
			await cp(
				resolve(root, "agents/assistant", directory!, "_examples", resourceId!),
				resolve(root, "agents/assistant", directory!, resourceId!),
				{ recursive: true },
			);
		}
		const agentPath = resolve(root, "agents/assistant/agent.json");
		const agent = JSON.parse(await readFile(agentPath, "utf8"));
		Object.assign(agent, {
			skills: ["example-skill"],
			files: [{ file: "example-file", mount_path: "/mnt/example.md" }],
			environment: "example-env",
			vault: "example-vault",
		});
		await writeFile(agentPath, JSON.stringify(agent));
		const preview = await previewProjectBuild(root);
		expect(preview.can_build).toBe(true);
		const loaded = (await inspectDirectoryProject(root)).loaded!;
		expect(Object.keys(loaded.config.skills ?? {})).toEqual(["example-skill"]);
		expect(Object.keys(loaded.config.files ?? {})).toEqual(["example-file"]);
		expect(Object.keys(loaded.config.environments ?? {})).toEqual(["example-env"]);
		expect(Object.keys(loaded.config.vaults ?? {})).toEqual(["example-vault"]);
		expect(preview.after_yaml).toContain("mount_path: /mnt/example.md");
		expect(preview.after_yaml).not.toContain("_examples");
	});

	test("does not discover or migrate draft examples including reserved-root metadata", async () => {
		const root = await fixture();
		await initializeDirectoryProject({ projectRoot: root });
		await writeFile(resolve(root, "agents/assistant/vaults/_examples/vault.json"), "invalid draft json");
		await writeFile(resolve(root, "agents/assistant/vaults/_examples/example-vault/vault.json"), "invalid draft json");
		await writeFile(resolve(root, "agents/assistant/files/_examples/loose.txt"), "Example, not an upload.");
		const preview = await previewProjectBuild(root);
		expect(preview.can_build).toBe(true);
		await commitProjectBuild({ projectRoot: root, baseRevision: preview.project_revision });
		expect(await readFile(resolve(root, "agents/assistant/vaults/_examples/vault.json"), "utf8")).toBe(
			"invalid draft json",
		);
		expect((await inspectDirectoryProject(root)).loaded?.config.files).toBeUndefined();
	});

	test("rejects existing example files or source symlinks before writing scaffold content", async () => {
		for (const occupied of [
			"agents/assistant/instructions.md",
			"agents/assistant/files/_examples/example-file/example.md",
		]) {
			const root = await fixture();
			await mkdir(dirname(resolve(root, occupied)), { recursive: true });
			await writeFile(resolve(root, occupied), "User-owned content");
			await expect(initializeDirectoryProject({ projectRoot: root })).rejects.toThrow("already exists");
			expect(await readFile(resolve(root, occupied), "utf8")).toBe("User-owned content");
			await expect(stat(resolve(root, "project.json"))).rejects.toMatchObject({ code: "ENOENT" });
		}
		const root = await fixture();
		const outside = await fixture();
		await symlink(outside, resolve(root, "agents"));
		await expect(initializeDirectoryProject({ projectRoot: root })).rejects.toThrow(/symlink/i);
		await expect(stat(resolve(root, "project.json"))).rejects.toMatchObject({ code: "ENOENT" });
	});
});
