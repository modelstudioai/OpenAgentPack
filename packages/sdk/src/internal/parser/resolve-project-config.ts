import { basename, dirname, resolve } from "node:path";
import { UserError } from "../errors.ts";
import type { ProjectConfig, ResolvedProjectConfig } from "../types/config.ts";
import { resolveFileReferences } from "./file-resolver.ts";
import { projectConfigSchema } from "./schema.ts";
import { loadConfig } from "./yaml-loader.ts";

export interface ResolveProjectConfigOptions {
	/** Override the derived project name (defaults to the config file's parent directory). */
	projectName?: string;
	/** Expand `${env:...}` references while loading (defaults to true). */
	resolveEnv?: boolean;
}

export interface LoadedProjectConfig {
	configPath: string;
	projectName: string;
	config: ResolvedProjectConfig;
}

/**
 * Shared config-resolution spine for every host: load the config file, raise
 * configuration errors as a UserError, then resolve file references. Interfaces
 * call this instead of re-implementing the load-and-resolve sequence.
 */
export async function resolveProjectConfig(
	filePath: string,
	options: ResolveProjectConfigOptions = {},
): Promise<LoadedProjectConfig> {
	const configPath = resolve(filePath);
	const projectName = options.projectName ?? basename(dirname(configPath));
	const { config: parsed, errors } = await loadConfig(configPath, options.resolveEnv ?? true);
	if (errors.length > 0) {
		throw new UserError(errors.join("\n"));
	}
	const config = await resolveFileReferences(parsed, configPath);
	return { configPath, projectName, config };
}

export interface ResolveProjectConfigFromObjectOptions {
	/** Project name to stamp onto the resolved config. */
	projectName: string;
	/** Base path used to resolve any `file:` references (defaults to process.cwd()). */
	basePath?: string;
}

/**
 * Object-level twin of {@link resolveProjectConfig}: validate an in-memory config
 * object through the same zod schema and file-reference resolution instead of
 * reading from disk. Hosts that assemble config from env + code (rather than a
 * yaml file) use this so they don't bypass SDK invariants like the `_resolved` marker.
 */
export async function resolveProjectConfigFromObject(
	rawConfig: unknown,
	options: ResolveProjectConfigFromObjectOptions,
): Promise<LoadedProjectConfig> {
	const basePath = resolve(options.basePath ?? process.cwd());
	const result = projectConfigSchema.safeParse(rawConfig);
	if (!result.success) {
		const errors = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
		throw new UserError(errors.join("\n"));
	}
	// file-resolver resolves refs relative to dirname(configPath); use a sentinel
	// file inside basePath so `file:` refs resolve against basePath itself.
	const anchor = resolve(basePath, "__in_memory_config__");
	const config = await resolveFileReferences(result.data as ProjectConfig, anchor);
	return { configPath: basePath, projectName: options.projectName, config };
}
