import JSZip from "jszip";
import type { SkillFile } from "../types/skill-file.ts";

/**
 * Normalize a skill zip so that SKILL.md is at the archive root.
 * If the zip has a common directory prefix (e.g. `skills/name/SKILL.md`),
 * strip it so the API sees `SKILL.md` at top level.
 */
export async function normalizeSkillZip(raw: Buffer): Promise<Uint8Array> {
	const inputZip = await JSZip.loadAsync(raw);
	const paths = Object.keys(inputZip.files).filter((p) => !inputZip.files[p]!.dir);

	// If SKILL.md is already at root, return as-is
	if (paths.includes("SKILL.md")) {
		return raw;
	}

	// Find the common prefix before SKILL.md
	const skillEntry = paths.find((p) => p.endsWith("/SKILL.md"));
	if (!skillEntry) {
		// No SKILL.md found at all — return as-is and let the API report the error
		return raw;
	}

	const prefix = skillEntry.slice(0, skillEntry.length - "SKILL.md".length);

	const outputZip = new JSZip();
	for (const filePath of paths) {
		if (filePath.startsWith(prefix)) {
			const newPath = filePath.slice(prefix.length);
			const content = await inputZip.files[filePath]!.async("uint8array");
			outputZip.file(newPath, content);
		}
	}

	return outputZip.generateAsync({ type: "uint8array" });
}

/** Normalize a skill zip and extract its entries to SkillFile[]. */
export async function extractSkillZipFiles(raw: Buffer): Promise<SkillFile[]> {
	const normalized = await normalizeSkillZip(raw);
	const zip = await JSZip.loadAsync(normalized);
	const files: SkillFile[] = [];
	for (const [path, entry] of Object.entries(zip.files)) {
		if (!entry!.dir) {
			const content = Buffer.from(await entry!.async("uint8array"));
			files.push({ relativePath: path, content });
		}
	}
	return files;
}
