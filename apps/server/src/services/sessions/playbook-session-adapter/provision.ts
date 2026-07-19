import type { CloudAgent } from "@openagentpack/sdk";
import {
	importResource,
	readProjectRuntime,
	resolveSessionProvider,
	syncAgentResourcesWithStateBackend,
	UserError,
	writeProjectRuntime,
} from "@openagentpack/sdk";
import { loadAgentRuntimeInput } from "@/services/runtime-factory";
import type { RemotePlaybookAgent } from "./runtime";

/**
 * Ensure a compiled catalog agent is provisioned to its provider (has a remote_id in state).
 * Always syncs before session start so provider/model drift (e.g. after switching AGENTS_PROVIDER)
 * is corrected on the remote agent.
 */
export async function ensureAgentApplied(
	playbookId: string,
	modelOverride?: string,
	matched?: CloudAgent,
): Promise<RemotePlaybookAgent> {
	const input = await loadAgentRuntimeInput(playbookId, modelOverride);
	const provider = resolveSessionProvider(input.agentId, input.config);
	await importMatchedCloudAgent(input, provider, matched);
	const run = await syncAgentResourcesWithStateBackend(input, input.agentId);
	if (run.status !== "completed") {
		throw new UserError(run.error ?? `Failed to provision agent '${input.agentId}' (status: ${run.status}).`);
	}
	const id = await readProjectRuntime(
		input,
		(ctx) => ctx.state.getResource({ type: "agent", name: input.agentId, provider })?.remote_id,
	);
	return { id: id ?? matched?.id ?? input.agentId };
}

async function importMatchedCloudAgent(
	input: Awaited<ReturnType<typeof loadAgentRuntimeInput>>,
	provider: string,
	matched?: CloudAgent,
): Promise<void> {
	if (!matched) return;
	await writeProjectRuntime(input, async (ctx) => {
		const address = { provider, type: "agent" as const, name: input.agentId };
		const existing = ctx.state.getResource(address);
		if (existing?.remote_id === matched.id) return;
		if (existing) ctx.state.removeResource(address);
		await importResource(ctx, address, matched.id, { resourceVersion: matched.version });
	});
}
