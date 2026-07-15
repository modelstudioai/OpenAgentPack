import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { UserError } from "../errors.ts";
import type { AgentDecl, MemoryEntryDecl, ProjectConfig, ResolvedProjectConfig } from "../types/config.ts";
import { isFileReference, loadPrompt } from "../utils/prompt-loader.ts";

export async function resolveFileReferences(config: ProjectConfig, configPath: string): Promise<ResolvedProjectConfig> {
	const basePath = configPath;
	const resolved = structuredClone(config) as ProjectConfig & { _resolved: true };

	if (resolved.agents) {
		for (const [name, agent] of Object.entries(resolved.agents)) {
			if (isFileReference(agent.instructions)) {
				(resolved.agents[name] as AgentDecl).instructions = await loadPrompt(agent.instructions, basePath);
			}
		}
	}

	if (resolved.memory_stores) {
		for (const [, store] of Object.entries(resolved.memory_stores)) {
			if (store.entries) {
				for (let i = 0; i < store.entries.length; i++) {
					const entry = store.entries[i]!;
					if (isFileReference(entry.content)) {
						const fullPath = resolve(dirname(basePath), entry.content);
						try {
							(store.entries[i] as MemoryEntryDecl).content = await readFile(fullPath, "utf8");
						} catch (err) {
							if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
								throw new UserError(`Memory entry file not found: ${fullPath} (entry key: ${entry.key})`);
							}
							throw new UserError(`Failed to read memory entry file: ${fullPath} (entry key: ${entry.key})`);
						}
					}
				}
			}
		}
	}

	resolved._resolved = true;
	return resolved as ResolvedProjectConfig;
}
