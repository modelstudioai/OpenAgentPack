import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { inspectSkillSource } from "../../src/internal/core/skill-source.ts";

const manifest = (name: string) => `---\nname: ${name}\ndescription: Test\n---\n# Skill\n`;

describe("local Skill source inspection", () => {
	test("normalizes a wrapped directory root", async () => {
		const root = await mkdtemp(join(tmpdir(), "skill-source-dir-"));
		await mkdir(join(root, "wrapper", "assets"), { recursive: true });
		await writeFile(join(root, "wrapper", "SKILL.md"), manifest("wrapped-skill"));
		await writeFile(join(root, "wrapper", "assets", "note.txt"), "ok");

		const inspected = await inspectSkillSource(root);

		expect(inspected.name).toBe("wrapped-skill");
		expect(inspected.files.map((file) => file.relativePath).sort()).toEqual(["SKILL.md", "assets/note.txt"]);
	});

	test("reads zip and single SKILL.md sources", async () => {
		const root = await mkdtemp(join(tmpdir(), "skill-source-files-"));
		const single = join(root, "SKILL.md");
		await writeFile(single, manifest("single-skill"));
		const zip = new JSZip();
		zip.file("bundle/SKILL.md", manifest("zip-skill"));
		zip.file("bundle/reference.md", "reference");
		const zipPath = join(root, "skill.zip");
		await writeFile(zipPath, await zip.generateAsync({ type: "uint8array" }));

		expect((await inspectSkillSource(single)).name).toBe("single-skill");
		const inspectedZip = await inspectSkillSource(zipPath);
		expect(inspectedZip.name).toBe("zip-skill");
		expect(inspectedZip.files.map((file) => file.relativePath).sort()).toEqual(["SKILL.md", "reference.md"]);
	});

	test("rejects missing or unnamed manifests", async () => {
		const root = await mkdtemp(join(tmpdir(), "skill-source-invalid-"));
		await writeFile(join(root, "README.md"), "missing");
		await expect(inspectSkillSource(root)).rejects.toThrow(/does not contain SKILL.md/);
		await writeFile(join(root, "SKILL.md"), "---\ndescription: Missing name\n---\n");
		await expect(inspectSkillSource(root)).rejects.toThrow(/non-empty name/);
	});
});
