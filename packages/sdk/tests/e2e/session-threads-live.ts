// Default: print the concrete create-only plan without changing Cloud resources.
// Execute only after reviewing that plan: KIT_LIVE=1 bun .../session-threads-live.ts --execute
// Credentials must already be in the process environment; this script never loads or prints an .env file.
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ApiError,
	createProjectRuntime,
	createSessionForAgent,
	deleteSession,
	destroyPlannedProjectResources,
	executePlannedProject,
	getSession,
	listSessionThreadEvents,
	listSessionThreads,
	type ProjectRuntimeContext,
	planDestroyProjectContext,
	planProjectContext,
	resolveProjectConfigFromObject,
	type SessionThread,
	StateManager,
	sendRemoteSessionEvents,
} from "../../src/index.ts";
import { sanitizeSessionEvents } from "../../src/session-events.ts";

const execute = process.argv.includes("--execute");
const prefix = process.env.KIT_THREAD_PREFIX ?? `kit-e2e-${Date.now()}-${randomUUID().slice(0, 8)}`;
const model = process.env.KIT_THREAD_MODEL ?? "qwen3.7-max";
const environmentId = process.env.KIT_THREAD_ENVIRONMENT_ID;
const metadata = { kit: "live-validation", probe: "session-threads", prefix };
const workerName = `${prefix}-worker`;
const coordinatorName = `${prefix}-coordinator`;
const environmentName = `${prefix}-environment`;

class ProbeFailure extends Error {}

function assert(value: unknown, message: string): asserts value {
	if (!value) throw new ProbeFailure(message);
}

function safeError(error: unknown): Record<string, unknown> {
	// Provider error bodies can echo credentials. Report only bounded classification.
	if (error instanceof ProbeFailure) return { kind: "assertion", message: error.message };
	return error instanceof ApiError
		? { kind: "provider_error", status: error.statusCode }
		: { kind: error instanceof Error ? error.name : "unknown_error" };
}

async function threadPages(ctx: ProjectRuntimeContext, sessionId: string): Promise<SessionThread[]> {
	const threads: SessionThread[] = [];
	const cursors = new Set<string>();
	let page: string | undefined;
	do {
		const result = await listSessionThreads(ctx, sessionId, { limit: 1, page, signal: AbortSignal.timeout(30_000) });
		threads.push(...result.data);
		if (!result.has_more) break;
		assert(result.next_page && !cursors.has(result.next_page), "Thread pagination returned an invalid cursor");
		cursors.add(result.next_page);
		page = result.next_page;
		assert(cursors.size <= 20, "Thread pagination exceeded the probe bound");
	} while (page);
	assert(new Set(threads.map((thread) => thread.id)).size === threads.length, "Thread pagination duplicated an ID");
	return threads;
}

async function verifyThreadHistory(
	ctx: ProjectRuntimeContext,
	sessionId: string,
	thread: SessionThread,
): Promise<void> {
	const ids = new Set<string>();
	const cursors = new Set<string>();
	let page: string | undefined;
	let sawMessage = false;
	let pages = 0;
	do {
		const result = await listSessionThreadEvents(ctx, sessionId, thread.id, {
			event_format: "snapshot",
			order: "asc",
			limit: 1,
			page_token: page,
			signal: AbortSignal.timeout(30_000),
		});
		pages += 1;
		for (const event of sanitizeSessionEvents(result.events, { redact: false, truncate: false })) {
			assert(event.event_id && !ids.has(event.event_id), "Thread event pagination lost or duplicated an ID");
			ids.add(event.event_id);
			assert(
				!event.metadata?.thread_id || event.metadata.thread_id === thread.id,
				"Thread history leaked another owner",
			);
			if (event.type === "message" && event.role === "assistant" && event.content?.length) sawMessage = true;
		}
		if (!result.has_more) break;
		assert(result.next_page && !cursors.has(result.next_page), "Thread event pagination returned an invalid cursor");
		cursors.add(result.next_page);
		page = result.next_page;
		assert(pages <= 200, "Thread event pagination exceeded the probe bound");
	} while (page);
	assert(pages > 1, "The thread did not exercise event cursor continuation");
	assert(sawMessage, "The child Agent produced no assistant message in thread history");
	console.log(JSON.stringify({ stage: "thread_history", threadId: thread.id, pages, events: ids.size }));
}

async function cleanup(ctx: ProjectRuntimeContext, sessionId?: string): Promise<boolean> {
	let complete = true;
	if (sessionId) {
		try {
			const current = await getSession(ctx, sessionId);
			if (current.status === "running") {
				await sendRemoteSessionEvents(ctx, sessionId, [{ role: "user", type: "interrupt" }]);
				const deadline = Date.now() + 30_000;
				while (Date.now() < deadline && (await getSession(ctx, sessionId)).status === "running") await Bun.sleep(1000);
			}
			await deleteSession(ctx, sessionId);
			console.log(JSON.stringify({ stage: "cleanup_session", sessionId, status: "deleted" }));
		} catch (error) {
			complete = false;
			console.log(JSON.stringify({ stage: "cleanup_session", sessionId, ...safeError(error) }));
		}
	}
	const planned = planDestroyProjectContext(ctx);
	const order = (name: string) => (name === coordinatorName ? 0 : name === workerName ? 1 : 2);
	planned.resources.sort((left, right) => order(left.address.name) - order(right.address.name));
	assert(
		planned.resources.every((resource) => resource.address.name.startsWith(`${prefix}-`)),
		"Cleanup scope escaped probe resources",
	);
	console.log(
		JSON.stringify({
			stage: "cleanup_plan",
			resources: planned.resources.map(({ address, remote_id }) => ({ address, id: remote_id })),
		}),
	);
	const result = await destroyPlannedProjectResources(planned);
	for (const item of result.results) {
		console.log(
			JSON.stringify({
				stage: "cleanup_resource",
				type: item.resource.address.type,
				id: item.resource.remote_id,
				status: item.status,
			}),
		);
	}
	return complete && !result.partial;
}

async function main(): Promise<void> {
	assert(
		/^kit-e2e-[a-zA-Z0-9-]+$/.test(prefix),
		"KIT_THREAD_PREFIX must start with kit-e2e- and use safe resource-name characters",
	);
	const apiKey = process.env.BAILIAN_API_KEY ?? process.env.DASHSCOPE_API_KEY;
	const baseUrl = process.env.BAILIAN_BASE_URL;
	const workspaceId = process.env.BAILIAN_WORKSPACE_ID;
	if (execute) {
		assert(process.env.KIT_LIVE === "1", "Explicit KIT_LIVE=1 is required for execution");
		assert(apiKey && (baseUrl || workspaceId), "Bailian credentials and base URL or workspace ID are required");
	}
	const directory = mkdtempSync(join(tmpdir(), `${prefix}-`));
	const statePath = join(directory, "state.json");
	const loaded = await resolveProjectConfigFromObject(
		{
			version: "1",
			providers: {
				bailian: {
					api_key: apiKey ?? "plan-only",
					...(baseUrl
						? { base_url: baseUrl }
						: workspaceId
							? { workspace_id: workspaceId }
							: { base_url: "https://bailian.test/api/v1/agentstudio" }),
				},
			},
			defaults: { provider: "bailian" },
			...(environmentId ? {} : { environments: { [environmentName]: { config: { type: "cloud" }, metadata } } }),
			agents: {
				[workerName]: {
					model,
					instructions:
						"You are a validation worker. Answer arithmetic questions with just the result. Do not use tools.",
					metadata,
				},
				[coordinatorName]: {
					model,
					instructions:
						"Delegate the user's arithmetic question to your worker Agent in a new child thread. Wait for the worker and return its result. Do not solve it yourself.",
					...(environmentId ? {} : { environment: environmentName }),
					multiagent: { type: "coordinator", agents: [workerName] },
					metadata,
				},
			},
		},
		{ projectName: prefix, basePath: directory },
	);
	const ctx = createProjectRuntime({ ...loaded, state: StateManager.initialize(statePath) });
	let sessionId: string | undefined;
	let created = false;
	let cleaned = false;
	try {
		const planned = await planProjectContext(ctx, {
			provider: "bailian",
			refresh: false,
			mode: "create-only",
			scope: {
				roots: [
					{ type: "agent", name: coordinatorName, provider: "bailian" },
					{ type: "agent", name: workerName, provider: "bailian" },
					...(environmentId ? [] : [{ type: "environment" as const, name: environmentName, provider: "bailian" }]),
				],
				includeDependencies: true,
			},
		});
		console.log(
			JSON.stringify({
				stage: "diagnostics",
				items: planned.plan.diagnostics.map(({ code, severity, resource }) => ({ code, severity, resource })),
			}),
		);
		assert(
			planned.plan.diagnostics.every((diagnostic) => diagnostic.severity !== "error"),
			"The probe plan has validation errors",
		);
		assert(
			planned.plan.actions.length === (environmentId ? 2 : 3),
			"The probe plan does not contain the expected resource count",
		);
		assert(
			planned.plan.actions.every(
				(action) => action.action === "create" && action.address.name.startsWith(`${prefix}-`),
			),
			"The probe plan contains an unexpected action",
		);
		console.log(
			JSON.stringify({
				stage: "plan",
				prefix,
				model,
				reuseEnvironment: Boolean(environmentId),
				actions: planned.plan.actions.map(({ action, address }) => ({ action, address })),
			}),
		);
		if (!execute) return;
		created = true;
		const applied = await executePlannedProject(planned, { policy: "block", concurrency: 1 });
		assert(
			!applied.partial && applied.results.every((result) => result.status === "success"),
			"Creating probe resources failed",
		);
		const createdSession = await createSessionForAgent(ctx, {
			agent: coordinatorName,
			environmentId,
			title: `${prefix}-session`,
			metadata,
		});
		sessionId = createdSession.session.id;
		console.log(JSON.stringify({ stage: "created", sessionId, prefix }));
		await sendRemoteSessionEvents(ctx, sessionId, [
			{
				role: "user",
				type: "message",
				content: [
					{
						type: "text",
						text: "Delegate 17 + 25 to your worker Agent in a new child thread. Wait for its reply and report the answer.",
					},
				],
			},
		]);
		const deadline = Date.now() + 180_000;
		let threads: SessionThread[] = [];
		while (Date.now() < deadline) {
			threads = await threadPages(ctx, sessionId);
			const current = await getSession(ctx, sessionId);
			if (threads.length && current.status === "idle" && threads.every((thread) => thread.status !== "running")) break;
			await Bun.sleep(3000);
		}
		assert(threads.length, "Coordinator created no child Agent thread within the probe deadline");
		assert(
			(await getSession(ctx, sessionId)).status === "idle",
			"Coordinator did not finish within the probe deadline",
		);
		assert(
			threads.every(
				(thread) => thread.id.startsWith("sthr_") && thread.session_id === sessionId && thread.parent_thread_id,
			),
			"Thread list lost child identity or parent/session linkage",
		);
		console.log(
			JSON.stringify({
				stage: "threads",
				count: threads.length,
				summaries: threads.map(({ id, parent_thread_id, agent, status }) => ({ id, parent_thread_id, agent, status })),
			}),
		);
		for (const thread of threads) await verifyThreadHistory(ctx, sessionId, thread);
		console.log(JSON.stringify({ stage: "verified", sessionId, threads: threads.length }));
	} finally {
		if (created) {
			try {
				cleaned = await cleanup(ctx, sessionId);
			} catch (error) {
				console.log(JSON.stringify({ stage: "cleanup_error", ...safeError(error) }));
			}
		}
		if (!created || cleaned) rmSync(directory, { recursive: true, force: true });
		else {
			console.log(JSON.stringify({ stage: "cleanup_incomplete", statePath, sessionId }));
			process.exitCode = 1;
		}
	}
}

await main().catch((error) => {
	console.error(JSON.stringify({ stage: "failed", ...safeError(error) }));
	process.exitCode = 1;
});
