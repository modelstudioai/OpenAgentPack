import { basename, dirname, resolve } from "node:path";
import { UserError } from "../errors.ts";
import type { ProjectConfig, ResolvedProjectConfig } from "../types/config.ts";
import { interpolateEnvVars } from "../utils/env.ts";
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
	/** Root config and local files/directories that influence the resolved project. */
	sourcePaths: string[];
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
	const sourcePaths = collectProjectSourcePaths(parsed, configPath, true);
	let config: ResolvedProjectConfig;
	try {
		config = await resolveFileReferences(parsed, configPath);
	} catch (error) {
		if (error && typeof error === "object") {
			Object.assign(error, { sourcePaths });
		}
		throw error;
	}
	return { configPath, projectName, config, sourcePaths };
}

export interface ResolveProjectConfigFromObjectOptions {
	/** Project name to stamp onto the resolved config. */
	projectName: string;
	/** Base path used to resolve any `file:` references (defaults to process.cwd()). */
	basePath?: string;
	/** Resolve `${ENV_VAR}` references recursively before schema validation. */
	resolveEnv?: boolean;
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
	const input = options.resolveEnv ? interpolateObjectEnv(rawConfig) : rawConfig;
	const result = projectConfigSchema.safeParse(input);
	if (!result.success) {
		const errors = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
		throw new UserError(errors.join("\n"));
	}
	// file-resolver resolves refs relative to dirname(configPath); use a sentinel
	// file inside basePath so `file:` refs resolve against basePath itself.
	const anchor = resolve(basePath, "__in_memory_config__");
	const parsed = result.data as ProjectConfig;
	const sourcePaths = collectProjectSourcePaths(parsed, anchor, false);
	const config = await resolveFileReferences(parsed, anchor);
	return { configPath: basePath, projectName: options.projectName, config, sourcePaths };
}

function interpolateObjectEnv(value: unknown): unknown {
	if (typeof value === "string") return interpolateEnvVars(value, true);
	if (Array.isArray(value)) return value.map(interpolateObjectEnv);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, interpolateObjectEnv(entry)]),
	);
}

function collectProjectSourcePaths(config: ProjectConfig, configPath: string, includeConfigPath: boolean): string[] {
	const baseDirectory = dirname(configPath);
	const paths = new Set<string>();
	if (includeConfigPath) paths.add(configPath);

	const addLocalPath = (value: string | undefined, requirePathSyntax = false): void => {
		if (!value || /^https?:\/\//i.test(value)) return;
		if (requirePathSyntax && !isLocalPathReference(value)) return;
		paths.add(resolve(baseDirectory, value));
	};

	for (const agent of Object.values(config.agents ?? {})) {
		addLocalPath(agent.instructions, true);
	}
	for (const store of Object.values(config.memory_stores ?? {})) {
		for (const entry of store.entries ?? []) addLocalPath(entry.content, true);
	}
	for (const skill of Object.values(config.skills ?? {})) addLocalPath(skill.source);
	for (const file of Object.values(config.files ?? {})) addLocalPath(file.source);
	for (const deployment of Object.values(config.deployments ?? {})) {
		for (const resource of deployment.resources ?? []) {
			if (resource.type === "file") addLocalPath(resource.source);
		}
		for (const event of deployment.initial_events ?? []) {
			if (event.type === "user.define_outcome") addLocalPath(event.rubric_file, true);
		}
	}

	return [...paths].sort();
}

function isLocalPathReference(value: string): boolean {
	return value.startsWith("./") || value.startsWith("../") || value.startsWith("/");
}
