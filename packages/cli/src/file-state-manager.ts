import { basename, dirname, resolve } from "node:path";
import { type IStateManager, LocalFileStateBackend, StateManager, type StateScope } from "@openagentpack/sdk";

function createCliStateScope(configPath: string, projectName?: string): StateScope {
	const resolved = resolve(configPath);
	return {
		projectId: projectName ?? basename(dirname(resolved)),
	};
}

/**
 * Load or initialize a file-based StateManager.
 */
export async function loadFileState(
	configPath: string,
	statePath?: string,
	projectName?: string,
): Promise<IStateManager> {
	const resolved = resolve(configPath);
	const backend = new LocalFileStateBackend({ configPath: resolved, statePath });
	const path = backend.getStatePath(createCliStateScope(resolved, projectName));
	return StateManager.load(path);
}
