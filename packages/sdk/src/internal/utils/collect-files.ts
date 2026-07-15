import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { SkillFile } from "../types/skill-file.ts";

// Walk a directory into a flat list of files. Entries are sorted at each level so
// skill uploads and content hashes are deterministic across machines.
export function collectFiles(dir: string, base: string): SkillFile[] {
	const results: SkillFile[] = [];
	for (const entry of readdirSync(dir).sort()) {
		const fullPath = resolve(dir, entry);
		const rel = base ? `${base}/${entry}` : entry;
		const entryStat = statSync(fullPath);
		if (entryStat.isFile()) {
			results.push({ relativePath: rel, content: readFileSync(fullPath) });
		} else if (entryStat.isDirectory()) {
			results.push(...collectFiles(fullPath, rel));
		}
	}
	return results;
}
