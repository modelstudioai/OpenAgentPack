import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { planAgentResourcesWithStateBackend, syncAgentResourcesWithStateBackend } from "@openagentpack/sdk";
import { errorResponses } from "@/schemas/common";
import {
	AgentApplyBodySchema,
	AgentApplyResponseSchema,
	AgentPlanBodySchema,
	AgentPlanResponseSchema,
	CreateProjectVersionBodySchema,
	CreateProjectVersionResponseSchema,
	DeclarationCommitResponseSchema,
	DeclarationDeleteBodySchema,
	DeclarationParamsSchema,
	DeclarationPatchBodySchema,
	DeclarationPreviewBodySchema,
	DeclarationPreviewResponseSchema,
	ProjectAgentParamsSchema,
	ProjectApplyBodySchema,
	ProjectApplyResponseSchema,
	ProjectDeclarationsResponseSchema,
	ProjectGitInitBodySchema,
	ProjectGitStatusSchema,
	ProjectGitToggleBodySchema,
	ProjectPlanBodySchema,
	ProjectPlanResponseSchema,
	ProjectSummarySchema,
	ProjectVersionActionBodySchema,
	ProjectVersionParamsSchema,
	ProjectVersionPreviewSchema,
	ProjectVersionRestoreResponseSchema,
	ProjectVersionsQuerySchema,
	ProjectVersionsResponseSchema,
} from "@/schemas/project";
import {
	commitDeclarationChange,
	listProjectDeclarations,
	previewDeclarationChange,
} from "@/services/project-declarations";
import {
	commitProjectVersionAfterApply,
	createProjectVersion,
	getProjectGitStatus,
	initializeProjectGit,
	listProjectVersions,
	prepareProjectVersionForApply,
	previewProjectVersion,
	restoreProjectVersion,
	setProjectVersioning,
} from "@/services/project-git";
import { projectRuntimeManager } from "@/services/project-manager";
import { projectMutationCoordinator } from "@/services/project-mutations";
import { planTokenStore, projectOperationStore } from "@/services/project-operations";
import { applyProjectRuntimeResources, planProjectRuntimeResources } from "@/services/project-runtime-plan";

export const projectRoute = new OpenAPIHono();

projectRuntimeManager.subscribe((event) => {
	if (event.type.startsWith("project.")) planTokenStore.invalidateAll();
});

const getProjectRoute = createRoute({
	method: "get",
	path: "/project",
	request: {
		query: z.object({ refresh: z.enum(["true", "false"]).optional() }),
	},
	responses: {
		200: {
			description: "Current agents.yaml project, validation, readiness, and deployment declarations",
			content: { "application/json": { schema: ProjectSummarySchema } },
		},
		...errorResponses,
	},
});

projectRoute.openapi(getProjectRoute, async (context) => {
	const { refresh } = context.req.valid("query");
	return context.json(await projectRuntimeManager.getSummary({ refreshReadiness: refresh === "true" }), 200);
});

const streamProjectRoute = createRoute({
	method: "get",
	path: "/project/events",
	responses: {
		200: {
			description: "Project reload and validation events",
			content: { "text/event-stream": { schema: z.string() } },
		},
		...errorResponses,
	},
});

projectRoute.openapi(streamProjectRoute, async (context) => {
	await projectRuntimeManager.ensureStarted();
	const initial = projectRuntimeManager.getSnapshot();
	const encoder = new TextEncoder();
	let unsubscribe: (() => void) | undefined;
	let unsubscribeMutation: (() => void) | undefined;
	let ping: ReturnType<typeof setInterval> | undefined;
	const stream = new ReadableStream({
		start(controller) {
			const send = (type: string, data: unknown) => {
				controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
			};
			send("project.snapshot", {
				status: initial.status,
				revision: initial.revision,
				active_mutation: projectMutationCoordinator.getSnapshot(),
			});
			unsubscribe = projectRuntimeManager.subscribe((event) => send(event.type, event));
			unsubscribeMutation = projectMutationCoordinator.subscribe((mutation) =>
				send("project.mutation", { active_mutation: mutation }),
			);
			ping = setInterval(() => send("ping", {}), 15_000);
		},
		cancel() {
			unsubscribe?.();
			unsubscribeMutation?.();
			if (ping) clearInterval(ping);
		},
	});
	context.req.raw.signal.addEventListener("abort", () => {
		unsubscribe?.();
		unsubscribeMutation?.();
		if (ping) clearInterval(ping);
	});
	return new Response(stream, { headers: sseHeaders() });
});

const listDeclarationsRoute = createRoute({
	method: "get",
	path: "/project/declarations",
	responses: {
		200: {
			description: "Editable declarations already present in agents.yaml",
			content: { "application/json": { schema: ProjectDeclarationsResponseSchema } },
		},
		...errorResponses,
	},
});

projectRoute.openapi(listDeclarationsRoute, async (context) => context.json(await listProjectDeclarations(), 200));

const previewDeclarationRoute = createRoute({
	method: "post",
	path: "/project/declarations/{type}/{id}/preview",
	request: {
		params: DeclarationParamsSchema,
		body: { content: { "application/json": { schema: DeclarationPreviewBodySchema } } },
	},
	responses: {
		200: {
			description: "Validate and preview an in-memory declaration change",
			content: { "application/json": { schema: DeclarationPreviewResponseSchema } },
		},
		...errorResponses,
	},
});

projectRoute.openapi(previewDeclarationRoute, async (context) => {
	const { type, id } = context.req.valid("param");
	const { base_revision: baseRevision, action, operations } = context.req.valid("json");
	return context.json(await previewDeclarationChange({ type, id, baseRevision, action, operations }), 200);
});

const patchDeclarationRoute = createRoute({
	method: "patch",
	path: "/project/declarations/{type}/{id}",
	request: {
		params: DeclarationParamsSchema,
		body: { content: { "application/json": { schema: DeclarationPatchBodySchema } } },
	},
	responses: {
		200: {
			description: "Atomically update an existing declaration in agents.yaml",
			content: { "application/json": { schema: DeclarationCommitResponseSchema } },
		},
		...errorResponses,
	},
});

projectRoute.openapi(patchDeclarationRoute, async (context) => {
	const { type, id } = context.req.valid("param");
	const { base_revision: baseRevision, operations } = context.req.valid("json");
	return context.json(await commitDeclarationChange({ type, id, baseRevision, action: "update", operations }), 200);
});

const deleteDeclarationRoute = createRoute({
	method: "delete",
	path: "/project/declarations/{type}/{id}",
	request: {
		params: DeclarationParamsSchema,
		body: { content: { "application/json": { schema: DeclarationDeleteBodySchema } } },
	},
	responses: {
		200: {
			description: "Atomically remove an unreferenced declaration from agents.yaml",
			content: { "application/json": { schema: DeclarationCommitResponseSchema } },
		},
		...errorResponses,
	},
});

projectRoute.openapi(deleteDeclarationRoute, async (context) => {
	const { type, id } = context.req.valid("param");
	const { base_revision: baseRevision } = context.req.valid("json");
	return context.json(await commitDeclarationChange({ type, id, baseRevision, action: "delete" }), 200);
});

const getProjectGitRoute = createRoute({
	method: "get",
	path: "/project/git",
	responses: {
		200: {
			description: "Local Git repository and agents.yaml version status",
			content: { "application/json": { schema: ProjectGitStatusSchema } },
		},
		...errorResponses,
	},
});

projectRoute.openapi(getProjectGitRoute, async (context) => context.json(await getProjectGitStatus(), 200));

const initProjectGitRoute = createRoute({
	method: "post",
	path: "/project/git/init",
	request: { body: { content: { "application/json": { schema: ProjectGitInitBodySchema } } } },
	responses: {
		200: {
			description: "Initialize local Git and create the first agents.yaml version",
			content: { "application/json": { schema: ProjectGitStatusSchema } },
		},
		...errorResponses,
	},
});

projectRoute.openapi(initProjectGitRoute, async (context) => {
	const { base_revision: baseRevision } = context.req.valid("json");
	return context.json(await initializeProjectGit({ baseRevision }), 200);
});

const enableProjectGitRoute = createRoute({
	method: "post",
	path: "/project/git/enable",
	request: { body: { content: { "application/json": { schema: ProjectGitToggleBodySchema } } } },
	responses: {
		200: {
			description: "Enable shared automatic agents.yaml versions and create a baseline when needed",
			content: { "application/json": { schema: ProjectGitStatusSchema } },
		},
		...errorResponses,
	},
});

projectRoute.openapi(enableProjectGitRoute, async (context) => {
	const { base_revision: baseRevision } = context.req.valid("json");
	return context.json(await setProjectVersioning({ baseRevision, enabled: true }), 200);
});

const disableProjectGitRoute = createRoute({
	method: "post",
	path: "/project/git/disable",
	request: { body: { content: { "application/json": { schema: ProjectGitToggleBodySchema } } } },
	responses: {
		200: {
			description: "Disable shared automatic agents.yaml versions without changing Git history",
			content: { "application/json": { schema: ProjectGitStatusSchema } },
		},
		...errorResponses,
	},
});

projectRoute.openapi(disableProjectGitRoute, async (context) => {
	const { base_revision: baseRevision } = context.req.valid("json");
	return context.json(await setProjectVersioning({ baseRevision, enabled: false }), 200);
});

const listProjectVersionsRoute = createRoute({
	method: "get",
	path: "/project/versions",
	request: { query: ProjectVersionsQuerySchema },
	responses: {
		200: {
			description: "Current-branch commits that modified agents.yaml",
			content: { "application/json": { schema: ProjectVersionsResponseSchema } },
		},
		...errorResponses,
	},
});

projectRoute.openapi(listProjectVersionsRoute, async (context) => {
	const { cursor, limit } = context.req.valid("query");
	return context.json(await listProjectVersions({ cursor, limit }), 200);
});

const createProjectVersionRoute = createRoute({
	method: "post",
	path: "/project/versions",
	request: { body: { content: { "application/json": { schema: CreateProjectVersionBodySchema } } } },
	responses: {
		201: {
			description: "Commit only the current agents.yaml to the current branch",
			content: { "application/json": { schema: CreateProjectVersionResponseSchema } },
		},
		...errorResponses,
	},
});

projectRoute.openapi(createProjectVersionRoute, async (context) => {
	const { base_revision: baseRevision, base_head: baseHead, message } = context.req.valid("json");
	return context.json(await createProjectVersion({ baseRevision, baseHead, message }), 201);
});

const previewProjectVersionRoute = createRoute({
	method: "post",
	path: "/project/versions/{commit}/preview",
	request: {
		params: ProjectVersionParamsSchema,
		body: { content: { "application/json": { schema: ProjectVersionActionBodySchema } } },
	},
	responses: {
		200: {
			description: "Validate and preview restoring a historical agents.yaml",
			content: { "application/json": { schema: ProjectVersionPreviewSchema } },
		},
		...errorResponses,
	},
});

projectRoute.openapi(previewProjectVersionRoute, async (context) => {
	const { commit } = context.req.valid("param");
	const { base_revision: baseRevision, base_head: baseHead } = context.req.valid("json");
	return context.json(await previewProjectVersion({ commit, baseRevision, baseHead }), 200);
});

const restoreProjectVersionRoute = createRoute({
	method: "post",
	path: "/project/versions/{commit}/restore",
	request: {
		params: ProjectVersionParamsSchema,
		body: { content: { "application/json": { schema: ProjectVersionActionBodySchema } } },
	},
	responses: {
		200: {
			description: "Restore historical agents.yaml content to the working tree without moving HEAD",
			content: { "application/json": { schema: ProjectVersionRestoreResponseSchema } },
		},
		...errorResponses,
	},
});

projectRoute.openapi(restoreProjectVersionRoute, async (context) => {
	const { commit } = context.req.valid("param");
	const { base_revision: baseRevision, base_head: baseHead } = context.req.valid("json");
	return context.json(await restoreProjectVersion({ commit, baseRevision, baseHead }), 200);
});

const planProjectRoute = createRoute({
	method: "post",
	path: "/project/plan",
	request: { body: { content: { "application/json": { schema: ProjectPlanBodySchema } } } },
	responses: {
		200: {
			description: "Plan all non-Deployment, non-Channel project runtime resources",
			content: { "application/json": { schema: ProjectPlanResponseSchema } },
		},
		...errorResponses,
	},
});

projectRoute.openapi(planProjectRoute, async (context) => {
	await projectRuntimeManager.ensureStarted();
	const { refresh } = context.req.valid("json");
	const snapshot = projectRuntimeManager.getSnapshot();
	const plan = await planProjectRuntimeResources(projectRuntimeManager.requireRuntimeInput(), {
		refresh: refresh ?? true,
	});
	const errorDiagnostic = plan.diagnostics.find((diagnostic) => diagnostic.severity === "error");
	if (errorDiagnostic) throw statusError(errorDiagnostic.message, 422);
	const scope = { kind: "project" as const };
	const token = planTokenStore.issue({
		scope,
		projectRevision: snapshot.revision!,
		fingerprint: plan.fingerprint,
		destructive: plan.destructiveActions.length > 0,
	});
	return context.json(
		{
			scope: "project_runtime" as const,
			project_revision: snapshot.revision!,
			plan_token: token.token,
			expires_at: new Date(token.expiresAt).toISOString(),
			fingerprint: plan.fingerprint,
			actions: redactForWire(plan.actions),
			diagnostics: redactForWire(plan.diagnostics),
			destructive: token.destructive,
		},
		200,
	);
});

const applyProjectRoute = createRoute({
	method: "post",
	path: "/project/apply",
	request: { body: { content: { "application/json": { schema: ProjectApplyBodySchema } } } },
	responses: {
		202: {
			description: "Automatically version agents.yaml and accept a project runtime apply",
			content: { "application/json": { schema: ProjectApplyResponseSchema } },
		},
		...errorResponses,
	},
});

projectRoute.openapi(applyProjectRoute, async (context) => {
	await projectRuntimeManager.ensureStarted();
	const { plan_token: planToken, confirm_destructive: confirmDestructive } = context.req.valid("json");
	const snapshot = projectRuntimeManager.getSnapshot();
	const scope = { kind: "project" as const };
	const token = planTokenStore.require(planToken, scope, snapshot.revision ?? "");
	if (token.destructive && !confirmDestructive) {
		throw statusError(
			"This plan contains destructive actions. Set confirm_destructive to true after reviewing it.",
			422,
		);
	}
	const versionMessage = `Apply project revision ${token.projectRevision.slice(0, 12)}`;
	const preparedVersion = await prepareProjectVersionForApply({
		baseRevision: token.projectRevision,
		baselineMessage: "Initialize agents.yaml",
	});
	const input = projectRuntimeManager.requireRuntimeInput();
	const lease = projectMutationCoordinator.acquire("project_apply");
	let operation: ReturnType<typeof projectOperationStore.create>;
	try {
		if ((await projectRuntimeManager.computeCurrentSourceRevision()) !== token.projectRevision) {
			throw statusError("Plan is stale because project configuration changed. Create a new plan.", 409);
		}
		const freshPlan = await planProjectRuntimeResources(input, { refresh: true });
		if (freshPlan.fingerprint !== token.fingerprint) {
			planTokenStore.consume(planToken);
			throw statusError("Plan is stale because project or remote resources changed. Create a new plan.", 409);
		}
		planTokenStore.require(planToken, scope, projectRuntimeManager.getSnapshot().revision ?? "");
		operation = projectOperationStore.create(scope, async (reporter) => {
			try {
				const run = await applyProjectRuntimeResources(input, token.fingerprint, { onFeedback: reporter.feedback });
				await commitProjectVersionAfterApply(preparedVersion, versionMessage);
				planTokenStore.invalidateAll();
				await projectRuntimeManager.refreshAfterMutation();
				return redactForWire(run);
			} finally {
				lease.release();
			}
		});
		lease.setOperationId(operation.id);
	} catch (error) {
		lease.release();
		throw error;
	}
	planTokenStore.consume(planToken);
	return context.json({ operation_id: operation.id, status: "queued" as const }, 202);
});

const planAgentRoute = createRoute({
	method: "post",
	path: "/project/agents/{agentId}/plan",
	request: {
		params: ProjectAgentParamsSchema,
		body: { content: { "application/json": { schema: AgentPlanBodySchema } } },
	},
	responses: {
		200: {
			description: "Scoped plan for one Agent and its runtime dependencies",
			content: { "application/json": { schema: AgentPlanResponseSchema } },
		},
		...errorResponses,
	},
});

projectRoute.openapi(planAgentRoute, async (context) => {
	await projectRuntimeManager.ensureStarted();
	const { agentId } = context.req.valid("param");
	const { refresh } = context.req.valid("json");
	const snapshot = projectRuntimeManager.getSnapshot();
	const input = projectRuntimeManager.requireRuntimeInput();
	const plan = await planAgentResourcesWithStateBackend(input, agentId, {
		refresh: refresh ?? true,
		scope: "runtime",
	});
	if (plan.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
		throw statusError(plan.diagnostics.find((diagnostic) => diagnostic.severity === "error")!.message, 422);
	}
	const token = planTokenStore.issue({
		scope: { kind: "agent", agentId },
		projectRevision: snapshot.revision!,
		fingerprint: plan.fingerprint,
		destructive: plan.destructiveActions.length > 0,
	});
	return context.json(
		{
			agent_id: agentId,
			provider: plan.provider,
			project_revision: snapshot.revision!,
			plan_token: token.token,
			expires_at: new Date(token.expiresAt).toISOString(),
			fingerprint: plan.fingerprint,
			actions: redactForWire(plan.actions),
			diagnostics: redactForWire(plan.diagnostics),
			destructive: token.destructive,
		},
		200,
	);
});

const applyAgentRoute = createRoute({
	method: "post",
	path: "/project/agents/{agentId}/apply",
	request: {
		params: ProjectAgentParamsSchema,
		body: { content: { "application/json": { schema: AgentApplyBodySchema } } },
	},
	responses: {
		202: {
			description: "Automatically version agents.yaml and accept an Agent apply",
			content: { "application/json": { schema: AgentApplyResponseSchema } },
		},
		...errorResponses,
	},
});

projectRoute.openapi(applyAgentRoute, async (context) => {
	await projectRuntimeManager.ensureStarted();
	const { agentId } = context.req.valid("param");
	const { plan_token: planToken, confirm_destructive: confirmDestructive } = context.req.valid("json");
	const snapshot = projectRuntimeManager.getSnapshot();
	const input = projectRuntimeManager.requireRuntimeInput();
	const scope = { kind: "agent" as const, agentId };
	const token = planTokenStore.require(planToken, scope, snapshot.revision!);
	if (token.destructive && !confirmDestructive) {
		throw statusError(
			"This plan contains destructive actions. Set confirm_destructive to true after reviewing it.",
			422,
		);
	}
	const versionMessage = `Apply agent ${agentId.slice(0, 60)} revision ${token.projectRevision.slice(0, 12)}`;
	const preparedVersion = await prepareProjectVersionForApply({
		baseRevision: token.projectRevision,
		baselineMessage: "Initialize agents.yaml",
	});

	const lease = projectMutationCoordinator.acquire("agent_apply");
	let operation: ReturnType<typeof projectOperationStore.create>;
	try {
		if ((await projectRuntimeManager.computeCurrentSourceRevision()) !== token.projectRevision) {
			throw statusError("Plan is stale because project configuration changed. Create a new plan.", 409);
		}
		const freshPlan = await planAgentResourcesWithStateBackend(input, agentId, {
			refresh: true,
			scope: "runtime",
		});
		if (freshPlan.fingerprint !== token.fingerprint) {
			planTokenStore.consume(planToken);
			throw statusError("Plan is stale because project or remote resources changed. Create a new plan.", 409);
		}
		try {
			planTokenStore.require(planToken, scope, projectRuntimeManager.getSnapshot().revision ?? "");
		} catch {
			planTokenStore.consume(planToken);
			throw statusError("Plan is stale because project configuration changed. Create a new plan.", 409);
		}
		operation = projectOperationStore.create(scope, async (reporter) => {
			try {
				const run = await syncAgentResourcesWithStateBackend(input, agentId, {
					refresh: true,
					scope: "runtime",
					expectedPlanFingerprint: token.fingerprint,
					policy: confirmDestructive ? "force" : "block",
					onFeedback: reporter.feedback,
				});
				if (run.status !== "completed") {
					throw statusError(
						run.error ?? `Agent apply ended with status '${run.status}'.`,
						run.reason === "plan_stale" ? 409 : 422,
					);
				}
				await commitProjectVersionAfterApply(preparedVersion, versionMessage);
				planTokenStore.invalidateAll();
				await projectRuntimeManager.refreshAfterMutation();
				return redactForWire(run);
			} finally {
				lease.release();
			}
		});
		lease.setOperationId(operation.id);
	} catch (error) {
		lease.release();
		throw error;
	}
	planTokenStore.consume(planToken);
	return context.json({ operation_id: operation.id, status: "queued" as const }, 202);
});

function statusError(message: string, status: number): Error & { status: number } {
	return Object.assign(new Error(message), { status });
}

function sseHeaders(): Record<string, string> {
	return {
		"Content-Type": "text/event-stream",
		"Cache-Control": "no-cache, no-transform",
		Connection: "keep-alive",
		"X-Accel-Buffering": "no",
	};
}

const SENSITIVE_KEY = /(access[_-]?key|api[_-]?key|authorization|credential|headers?|password|secret|signature|token)/i;

function redactForWire<T>(value: T): T {
	if (Array.isArray(value)) return value.map((item) => redactForWire(item)) as T;
	if (!value || typeof value !== "object") return value;
	const output: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value)) {
		output[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : redactForWire(entry);
	}
	return output as T;
}
