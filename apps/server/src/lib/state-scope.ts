import { copyFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { LocalFileStateBackend, type StateScope } from "@openagentpack/sdk";
import { RUNTIME_PROJECT_NAME } from "@/lib/build-runtime-config";

/**
 * Default playground state lives in the user home directory, alongside the
 * provider config (~/.agents/config.json). This avoids colliding with CLI
 * example configs that happen to live in the repo's examples/ directory.
 *
 * Override with AGENTS_STATE_PATH for custom deployment layouts.
 */
const DEFAULT_STATE_PATH = join(homedir(), ".agents", "playground.state.json");

/**
 * Legacy state path. Before this migration the server stored its state inside
 * the repo's example directory. We migrate it once so previously-provisioned
 * remote_ids are preserved.
 */
const LEGACY_STATE_PATH = "examples/bailian/bailian-cli/agents.state.json";

let migrationChecked = false;

/**
 * One-time migration: if the legacy state file exists and the new default does
 * not, copy it over and log a warning. Idempotent — subsequent calls after a
 * successful migration (or when no migration is needed) are no-ops. A failed
 * copy allows retry on the next call so transient I/O errors don't permanently
 * disable migration for the process lifetime.
 */
function ensureMigrated(newPath: string, cwd: string): void {
	if (migrationChecked) return;

	if (existsSync(newPath)) {
		migrationChecked = true;
		return;
	}
	const legacyPath = resolve(cwd, LEGACY_STATE_PATH);
	if (!existsSync(legacyPath)) {
		migrationChecked = true;
		return;
	}

	try {
		mkdirSync(dirname(newPath), { recursive: true });
		copyFileSync(legacyPath, newPath);
		// Rename the legacy file so a version rollback won't silently read stale state.
		try {
			renameSync(legacyPath, `${legacyPath}.migrated`);
		} catch {
			// Non-fatal: the copy succeeded, state is in the new location.
		}
		migrationChecked = true;
		console.warn(
			`[state] Migrated playground state from legacy path:\n` +
				`         ${legacyPath}\n` +
				`       → ${newPath}\n` +
				`       The legacy file has been renamed to ${legacyPath}.migrated.`,
		);
	} catch (error) {
		// Don't set migrationChecked — allow retry on next call.
		console.warn(`[state] Failed to migrate legacy state file: ${error instanceof Error ? error.message : error}`);
	}
}

export function resolveStatePath(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
	const configured = env.AGENTS_STATE_PATH?.trim();
	if (configured) return resolve(cwd, configured);

	ensureMigrated(DEFAULT_STATE_PATH, cwd);
	return DEFAULT_STATE_PATH;
}

export function deriveWebUiStateScope(): StateScope {
	return { projectId: RUNTIME_PROJECT_NAME };
}

export function createWebUiStateBackend(input: { statePath?: string } = {}): LocalFileStateBackend {
	return new LocalFileStateBackend({ statePath: input.statePath ?? resolveStatePath() });
}
