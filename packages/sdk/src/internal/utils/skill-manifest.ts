import type { SkillFile } from "../types/skill-file.ts";

/**
 * Extract a skill's canonical name from its SKILL.md YAML frontmatter `name`
 * field. Providers register a skill under this name rather than the agents.yaml
 * key — Bailian reads it server-side from the uploaded archive, while
 * claude/ark use it as the archive directory name. It is therefore the
 * reliable name to look up an already-existing skill by for adoption. Returns
 * undefined when there is no SKILL.md or its frontmatter omits `name`.
 */
export function skillNameFromFiles(files: SkillFile[]): string | undefined {
	const skillMd = files.find((f) => f.relativePath === "SKILL.md" || f.relativePath.endsWith("/SKILL.md"));
	if (!skillMd) return undefined;
	const match = skillMd.content.toString("utf-8").match(/^name:\s*(.+?)\s*$/m);
	return match?.[1]?.replace(/^["']|["']$/g, "") || undefined;
}
