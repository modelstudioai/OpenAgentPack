import { bootstrapRuntimeCredentialsSync } from "@openagentpack/sdk";

let bootstrapped = false;

/**
 * Lazily load `.env` and `~/.agents/config.json` into `process.env`.
 * Safe to call multiple times — only the first call performs I/O.
 *
 * This replaces the unconditional `bootstrapRuntimeCredentialsSync()` that
 * previously ran at CLI boot for every command (including `--version` and `init`).
 * Now only commands that actually talk to a provider trigger credential loading.
 */
export function ensureCredentials(): void {
	if (bootstrapped) return;
	bootstrapped = true;
	bootstrapRuntimeCredentialsSync();
}
