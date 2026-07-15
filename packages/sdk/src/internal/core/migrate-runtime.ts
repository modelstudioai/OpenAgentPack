import { readFile } from "node:fs/promises";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { UserError } from "../errors.ts";

export interface MigrateOptions {
	fromPath: string; // synced.yaml path
	toPath: string; // agents.yaml path
}

export interface MigrateResult {
	added: Record<string, number>; // type → count of added resources
	skipped: Record<string, number>; // type → count of skipped (already exist)
	yaml: string; // merged yaml output
}

/** Resource group keys that can be migrated from synced.yaml to agents.yaml. */
const RESOURCE_GROUPS = ["environments", "vaults", "files", "skills", "agents"] as const;

/**
 * Migrate resources from a synced.yaml into an existing agents.yaml.
 *
 * - Uses the target agents.yaml's provider (from `defaults.provider` or the first provider key)
 * - Appends resources that don't already exist (by YAML key)
 * - Skips resources whose key already exists in the target
 * - Replaces the `provider` field on each migrated resource with the target provider
 */
export async function migrateConfig(opts: MigrateOptions): Promise<MigrateResult> {
	const [fromRaw, toRaw] = await Promise.all([readYaml(opts.fromPath), readYaml(opts.toPath)]);

	// Determine target provider from agents.yaml
	const targetProvider = resolveTargetProvider(toRaw);

	const added: Record<string, number> = {};
	const skipped: Record<string, number> = {};

	for (const group of RESOURCE_GROUPS) {
		const fromGroup = (fromRaw[group] ?? {}) as Record<string, Record<string, unknown>>;
		const toGroup = ((toRaw[group] as Record<string, unknown>) ?? {}) as Record<string, Record<string, unknown>>;

		for (const [key, decl] of Object.entries(fromGroup)) {
			if (key in toGroup) {
				skipped[group] = (skipped[group] ?? 0) + 1;
				continue;
			}
			// Replace provider with target provider
			const migrated = { ...decl };
			migrated.provider = targetProvider;
			// Normalize agent skill types and remap skill_id from source remote ID to YAML key
			if (group === "agents" && Array.isArray(migrated.skills)) {
				// Build a mapping: source skill remote_id → YAML key in the synced skills
				const skillRemoteIdToKey = new Map<string, string>();
				const fromSkills = (fromRaw.skills ?? {}) as Record<string, Record<string, unknown>>;
				for (const [skillKey, skillDecl] of Object.entries(fromSkills)) {
					// Map by YAML key itself (key = remote ID)
					skillRemoteIdToKey.set(skillKey, skillKey);
					// Map by name if present (for display-name-keyed skills)
					if (skillDecl.name && typeof skillDecl.name === "string") {
						skillRemoteIdToKey.set(skillDecl.name, skillKey);
					}
				}

				migrated.skills = (migrated.skills as Array<Record<string, unknown>>).map((s) => {
					if (typeof s !== "object") return s;
					const normalized = { ...s };
					// Normalize type
					if (normalized.type && normalized.type !== "custom" && normalized.type !== "official") {
						normalized.type = "official";
					}
					// Remap skill_id from source remote ID to target YAML key
					if (normalized.skill_id && typeof normalized.skill_id === "string") {
						const targetKey = skillRemoteIdToKey.get(normalized.skill_id as string);
						if (targetKey) {
							normalized.skill_id = targetKey;
						}
					}
					return normalized;
				});
			}
			// Normalize agent model for target provider
			if (group === "agents" && targetProvider === "bailian") {
				migrated.model = "qwen3.7-plus";
				// Normalize tools to Bailian's supported builtin list
				if (migrated.tools && typeof migrated.tools === "object") {
					(migrated.tools as Record<string, unknown>).builtin = [
						"bash",
						"write",
						"read",
						"edit",
						"glob",
						"grep",
						"download_file",
					];
				}
			}
			// Normalize environment networking for Bailian (only supports unrestricted)
			if (group === "environments" && targetProvider === "bailian") {
				const config = migrated.config as Record<string, unknown> | undefined;
				if (config?.networking) {
					config.networking = { type: "unrestricted" };
				}
				// Bailian only supports apt, npm, pip package managers
				if (config?.packages && typeof config.packages === "object") {
					const packages = config.packages as Record<string, unknown>;
					const SUPPORTED_MANAGERS = new Set(["type", "apt", "npm", "pip"]);
					for (const key of Object.keys(packages)) {
						if (!SUPPORTED_MANAGERS.has(key)) {
							delete packages[key];
						}
					}
				}
			}
			// Normalize vault credentials for Bailian (only supports environment_variable)
			if (group === "vaults" && targetProvider === "bailian") {
				const credentials = migrated.credentials as Array<Record<string, unknown>> | undefined;
				if (credentials) {
					migrated.credentials = credentials.filter((c) => c.type === "environment_variable");
				}
			}
			toGroup[key] = migrated;
			added[group] = (added[group] ?? 0) + 1;
		}

		// Only set the group on target if it has entries
		if (Object.keys(toGroup).length > 0) {
			toRaw[group] = toGroup;
		}
	}

	const yaml = stringifyYaml(toRaw, { lineWidth: 0 });
	return { added, skipped, yaml };
}

function resolveTargetProvider(config: Record<string, unknown>): string {
	// Try defaults.provider
	const defaults = config.defaults as Record<string, unknown> | undefined;
	if (defaults?.provider && typeof defaults.provider === "string") {
		return defaults.provider;
	}
	// Fall back to first key in providers block
	const providers = config.providers as Record<string, unknown> | undefined;
	if (providers) {
		const keys = Object.keys(providers);
		if (keys.length > 0) return keys[0]!;
	}
	throw new UserError(
		"Cannot determine target provider from agents.yaml. Set `defaults.provider` or add a provider to the `providers` block.",
	);
}

async function readYaml(path: string): Promise<Record<string, unknown>> {
	let raw: string;
	try {
		raw = await readFile(path, "utf8");
	} catch (err) {
		if (err && typeof err === "object" && "code" in err && (err as { code: string }).code === "ENOENT") {
			throw new UserError(`File not found: ${path}`);
		}
		throw err;
	}
	const parsed = parseYaml(raw);
	if (!parsed || typeof parsed !== "object") {
		throw new UserError(`Invalid YAML in ${path}`);
	}
	return parsed as Record<string, unknown>;
}
