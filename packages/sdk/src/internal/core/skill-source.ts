import { readFileSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { parse } from "yaml";
import { UserError } from "../errors.ts";
import type { SkillFile } from "../types/skill-file.ts";
import { collectFiles } from "../utils/collect-files.ts";
import { extractSkillZipFiles } from "../utils/normalize-skill-zip.ts";

export interface SkillSourceInspection {
	name: string;
	sourcePath: string;
	files: SkillFile[];
}

/** Inspect and normalize a local Skill directory, zip, or single SKILL.md. */
export async function inspectSkillSource(
	source: string,
	options: { basePath?: string } = {},
): Promise<SkillSourceInspection> {
	if (/^https?:\/\//i.test(source)) {
		throw new UserError("Skill source inspection only accepts a local directory, zip, or SKILL.md file.");
	}
	const sourcePath = resolve(options.basePath ?? process.cwd(), source);
	const sourceStat = statSync(sourcePath, { throwIfNoEntry: false });
	if (!sourceStat) throw new UserError(`Skill source not found: ${source}`);

	let files: SkillFile[];
	if (sourceStat.isDirectory()) {
		files = collectFiles(sourcePath, "");
	} else if (sourceStat.isFile() && sourcePath.toLowerCase().endsWith(".zip")) {
		files = await extractSkillZipFiles(readFileSync(sourcePath));
	} else if (sourceStat.isFile() && basename(sourcePath).toLowerCase() === "skill.md") {
		files = [{ relativePath: "SKILL.md", content: readFileSync(sourcePath) }];
	} else {
		throw new UserError("Skill source must be a directory, .zip archive, or SKILL.md file.");
	}

	const normalizedFiles = normalizeSkillRoot(files);
	const manifest = normalizedFiles.find((file) => file.relativePath === "SKILL.md")!;
	const name = parseSkillManifestName(manifest.content);
	return { name, sourcePath, files: normalizedFiles };
}

function normalizeSkillRoot(files: SkillFile[]): SkillFile[] {
	if (files.some((file) => file.relativePath === "SKILL.md")) return files;
	const manifests = files.filter((file) => file.relativePath.endsWith("/SKILL.md"));
	if (manifests.length === 0) throw new UserError("Skill source does not contain SKILL.md.");
	if (manifests.length > 1) {
		throw new UserError("Skill source contains multiple SKILL.md files and has no unambiguous root.");
	}
	const prefix = manifests[0]!.relativePath.slice(0, -"SKILL.md".length);
	return files
		.filter((file) => file.relativePath.startsWith(prefix))
		.map((file) => ({ ...file, relativePath: file.relativePath.slice(prefix.length) }));
}

function parseSkillManifestName(content: Buffer): string {
	const text = content.toString("utf8");
	const frontmatter = text.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/);
	if (!frontmatter) throw new UserError("SKILL.md must start with YAML frontmatter containing a name.");
	let manifest: unknown;
	try {
		manifest = parse(frontmatter[1]!);
	} catch (error) {
		throw new UserError(`Invalid SKILL.md frontmatter: ${error instanceof Error ? error.message : String(error)}`);
	}
	const rawName = manifest && typeof manifest === "object" ? (manifest as Record<string, unknown>).name : undefined;
	const name = typeof rawName === "string" ? rawName.trim() : "";
	if (!name) throw new UserError("SKILL.md frontmatter must contain a non-empty name.");
	return name;
}
