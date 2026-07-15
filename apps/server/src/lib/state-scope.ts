import { resolve } from "node:path";
import { LocalFileStateBackend, type StateScope } from "@openagentpack/sdk";
import { RUNTIME_PROJECT_NAME } from "@/lib/build-runtime-config";

// Historical on-disk state anchor. Previously derived via deriveStatePath() from the
// demo file examples/bailian/bailian-cli/agents.yaml → agents.state.json. We pin the default
// to that exact location so previously provisioned remote_ids (agents/vault/environment)
// keep resolving and are not re-created. Override with AGENTS_STATE_PATH.
const DEFAULT_STATE_PATH = "examples/bailian/bailian-cli/agents.state.json";

export function resolveStatePath(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
	const configured = env.AGENTS_STATE_PATH?.trim();
	return configured ? resolve(cwd, configured) : resolve(cwd, DEFAULT_STATE_PATH);
}

export function deriveWebUiStateScope(): StateScope {
	return { projectId: RUNTIME_PROJECT_NAME };
}

export function createWebUiStateBackend(input: { statePath?: string } = {}): LocalFileStateBackend {
	return new LocalFileStateBackend({ statePath: input.statePath ?? resolveStatePath() });
}
