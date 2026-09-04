import { dirname } from "node:path";
import { inspectSkillSource } from "../core/skill-source.ts";
import { resolveFetch } from "../transport.ts";
import type { SkillDecl } from "../types/config.ts";
import type { SkillFile } from "../types/skill-file.ts";
import { extractSkillZipFiles } from "../utils/normalize-skill-zip.ts";
import type { ExecContext } from "./context.ts";

// Resolve a skill's files for upload. A remote `http(s)` source is fetched (a zip); a local source
// is read relative to configPath (zip, directory, or a single SKILL.md).
export async function resolveSkillFiles(decl: SkillDecl, ctx: ExecContext): Promise<SkillFile[]> {
	if (/^https?:\/\//i.test(decl.source)) {
		const res = await resolveFetch()(decl.source);
		if (!res.ok) throw new Error(`skill source 下载失败：${res.status} ${decl.source}`);
		return extractSkillZipFiles(Buffer.from(await res.arrayBuffer()));
	}

	if (!ctx.configPath) return [];

	return (await inspectSkillSource(decl.source, { basePath: dirname(ctx.configPath) })).files;
}
