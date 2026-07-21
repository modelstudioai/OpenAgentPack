import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
	executePlannedProject,
	getDeploymentDetailsForContext,
	pauseDeploymentForContext,
	planProjectContext,
	type ResolvedProjectConfig,
	runDeploymentForContext,
	syncAgentResourcesWithStateBackend,
	UserError,
	writeProjectRuntime,
} from "@openagentpack/sdk";
import { loadCompiledRuntimeInput } from "@/services/runtime-factory";

export interface StoredDeployment {
	id: string;
	name: string;
	playbookId: string;
	prompt: string;
	expression: string;
	timezone: string;
	provider: "qoder" | "claude";
}

const storePath = () =>
	process.env.AGENTS_DEPLOYMENTS_PATH?.trim() || join(homedir(), ".agents", "playground.deployments.json");

async function readStore(): Promise<StoredDeployment[]> {
	try {
		const parsed = JSON.parse(await readFile(storePath(), "utf8")) as { deployments?: StoredDeployment[] };
		return Array.isArray(parsed.deployments)
			? parsed.deployments.map((item) => ({
					...item,
					// Legacy records predate provider ownership. The active provider is the only
					// recoverable source for those records; every new record persists it explicitly.
					provider: item.provider ?? process.env.AGENTS_PROVIDER,
				}))
			: [];
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw error;
	}
}

async function writeStore(deployments: StoredDeployment[]): Promise<void> {
	const path = storePath();
	await mkdir(dirname(path), { recursive: true });
	const temp = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
	await writeFile(temp, `${JSON.stringify({ deployments }, null, 2)}\n`, { mode: 0o600 });
	await rename(temp, path);
}

function attachDeployment(input: Awaited<ReturnType<typeof loadCompiledRuntimeInput>>, item: StoredDeployment) {
	const config = JSON.parse(JSON.stringify(input.config)) as ResolvedProjectConfig;
	config.deployments = {
		...(config.deployments ?? {}),
		[item.id]: {
			agent: input.compiled.agentId,
			environment: Object.keys(config.environments ?? {})[0],
			initial_events: [{ type: "user.message", content: item.prompt }],
			schedule: { expression: item.expression, timezone: item.timezone },
			description: item.name,
			provider: config.defaults?.provider,
			metadata: { "openagentpack.webui": "schedule", "openagentpack.title": item.name },
		},
	};
	return { ...input, config, providers: config.providers };
}

async function runtimeFor(item: StoredDeployment) {
	return attachDeployment(await loadCompiledRuntimeInput(item.playbookId, item.provider), item);
}

function assertNativeProvider(provider: string | undefined): asserts provider is "qoder" | "claude" {
	if (provider !== "qoder" && provider !== "claude") {
		throw new UserError(
			`WebUI schedules require a native deployment provider (qoder or claude), got '${provider ?? "unknown"}'.`,
		);
	}
}

async function executeOnlyDeployment(input: Awaited<ReturnType<typeof runtimeFor>>, id: string, deleting = false) {
	return writeProjectRuntime(input, async (ctx) => {
		const planned = await planProjectContext(ctx, { provider: input.config.defaults?.provider, quiet: true });
		const actions = planned.plan.actions.filter(
			(action) =>
				action.address.type === "deployment" && action.address.name === id && (!deleting || action.action === "delete"),
		);
		if (actions.length === 0)
			throw new UserError(`Deployment '${id}' produced no ${deleting ? "delete" : "apply"} action.`);
		const execution = await executePlannedProject(
			{
				...planned,
				plan: { ...planned.plan, actions },
				destructiveActions: actions.filter((a) => a.action === "delete"),
			},
			{ policy: deleting ? "force" : "block" },
		);
		const failed = execution.results.find((result) => result.status !== "success");
		if (failed) {
			throw new UserError(failed.error ?? `Deployment '${id}' ${failed.status}.`);
		}
		return execution;
	});
}

let storeMutationQueue: Promise<void> = Promise.resolve();

function serializeStoreMutation<T>(mutation: () => Promise<T>): Promise<T> {
	const result = storeMutationQueue.then(mutation, mutation);
	storeMutationQueue = result.then(
		() => undefined,
		() => undefined,
	);
	return result;
}

export async function listManagedDeployments() {
	const records = await readStore();
	return Promise.all(
		records.map(async (item) => {
			try {
				const input = await runtimeFor(item);
				assertNativeProvider(input.config.defaults?.provider);
				return await writeProjectRuntime(input, async (ctx) => {
					const detail = await getDeploymentDetailsForContext(ctx, item.id);
					return {
						...item,
						provider: detail.provider,
						schedule: { expression: item.expression, timezone: item.timezone },
						status: detail.info.status,
						remoteId: detail.info.id,
					};
				});
			} catch {
				return {
					...item,
					schedule: { expression: item.expression, timezone: item.timezone },
					status: "unavailable",
					remoteId: null,
				};
			}
		}),
	);
}

export async function createManagedDeployment(input: Omit<StoredDeployment, "id" | "provider">) {
	return serializeStoreMutation(async () => {
		const records = await readStore();
		const id = `schedule-${crypto.randomUUID()}`;
		const base = await loadCompiledRuntimeInput(input.playbookId);
		assertNativeProvider(base.config.defaults?.provider);
		const item: StoredDeployment = { ...input, id, provider: base.config.defaults.provider };
		const runtime = attachDeployment(base, item);
		const agentRun = await syncAgentResourcesWithStateBackend(runtime, runtime.compiled.agentId);
		if (agentRun.status !== "completed") throw new UserError(agentRun.error ?? "Failed to provision schedule agent.");
		await executeOnlyDeployment(runtime, id);
		await writeStore([...records, item]);
		return (await listManagedDeployments()).find((deployment) => deployment.id === id)!;
	});
}

async function requireStored(id: string) {
	const records = await readStore();
	const item = records.find((record) => record.id === id);
	if (!item) throw new UserError(`Deployment '${id}' not found.`);
	return { item, records };
}

export async function setManagedDeploymentPaused(id: string, paused: boolean) {
	const { item } = await requireStored(id);
	const input = await runtimeFor(item);
	return writeProjectRuntime(input, (ctx) => pauseDeploymentForContext(ctx, id, paused));
}

export async function runManagedDeployment(id: string) {
	const { item } = await requireStored(id);
	const input = await runtimeFor(item);
	const run = await writeProjectRuntime(input, (ctx) => runDeploymentForContext(ctx, id));
	if (run.result.error) {
		throw new UserError(`Deployment run failed: ${run.result.error.type} - ${run.result.error.message}`);
	}
	return run;
}

export async function deleteManagedDeployment(id: string) {
	return serializeStoreMutation(async () => {
		const { item, records } = await requireStored(id);
		const input = await runtimeFor(item);
		input.config.deployments = {};
		await executeOnlyDeployment(input, id, true);
		await writeStore(records.filter((record) => record.id !== id));
		return { deleted: true };
	});
}
