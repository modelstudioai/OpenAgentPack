import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import type { ProjectConfig } from "../types/config.ts";
import { interpolateEnvVars, interpolateObjectEnv } from "../utils/env.ts";
import { projectConfigSchema } from "./schema.ts";

export interface LoadResult {
	config: ProjectConfig;
	errors: string[];
}

export async function loadConfig(
	filePath: string,
	resolveEnv = false,
	environment?: Record<string, string | undefined>,
): Promise<LoadResult> {
	let raw: string;
	try {
		raw = await readFile(filePath, "utf8");
	} catch (err) {
		if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
			return { config: null as never, errors: [`File not found: ${filePath}`] };
		}
		const msg = err instanceof Error ? err.message : String(err);
		return { config: null as never, errors: [`Failed to read file: ${msg}`] };
	}

	if (resolveEnv && !environment) {
		raw = interpolateEnvVars(raw, true);
	}

	let parsed: unknown;
	try {
		parsed = parseYaml(raw);
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		return { config: null as never, errors: [`YAML parse error: ${msg}`] };
	}

	// Project-local environments interpolate parsed scalars, never YAML syntax:
	// a secret containing quotes/newlines must not inject or corrupt declarations.
	if (resolveEnv && environment) parsed = interpolateObjectEnv(parsed, environment);
	const result = projectConfigSchema.safeParse(parsed);
	if (!result.success) {
		const errors = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
		return { config: null as never, errors };
	}

	return { config: result.data as ProjectConfig, errors: [] };
}
