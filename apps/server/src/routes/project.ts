import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import {
	acquireDirectoryProjectMutation,
	commitProjectBuild,
	previewProjectBuild,
	readValidProjectBuild,
} from "@openagentpack/project-workspace";
import { planAgentResourcesWithStateBackend, syncAgentResourcesWithStateBackend } from "@openagentpack/sdk";
import { errorResponses } from "@/schemas/common";
import {
	AgentApplyBodySchema,
	AgentApplyResponseSchema,
	AgentPlanBodySchema,
	AgentPlanResponseSchema,
	DeclarationCommitResponseSchema,
	DeclarationDeleteBodySchema,
	DeclarationParamsSchema,
	DeclarationPatchBodySchema,
	DeclarationPreviewBodySchema,
	DeclarationPreviewResponseSchema,
	ProjectAgentParamsSchema,
	ProjectApplyBodySchema,
	ProjectApplyResponseSchema,
	ProjectBuildBodySchema,
	ProjectBuildResponseSchema,
	ProjectDeclarationsResponseSchema,
	ProjectPlanBodySchema,
	ProjectPlanResponseSchema,
	ProjectSummarySchema,
	ProjectVersionActionBodySchema,
	ProjectVersioningStatusSchema,
	ProjectVersioningToggleBodySchema,
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
import { projectRuntimeManager } from "@/services/project-manager";
import { projectMutationCoordinator } from "@/services/project-mutations";
import { planTokenStore, projectOperationStore } from "@/services/project-operations";
import { applyProjectRuntimeResources, planProjectRuntimeResources } from "@/services/project-runtime-plan";
import {
	commitProjectVersionAfterApply,
	getProjectVersioningStatus,
	listProjectVersions,
	prepareProjectVersionForApply,
	previewProjectVersion,
	releaseProjectVersionAfterApply,
	restoreProjectVersion,
	setProjectVersioning,
} from "@/services/project-versions";

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
			description: "Current directory project, validation, readiness, Build, and deployment declarations",
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

const getProjectVersioningRoute = createRoute({
	method: "get",
	path: "/project/versioning",
	responses: {
		200: {
			description: "Local directory source snapshot store and versioning status",
			content: { "application/json": { schema: ProjectVersioningStatusSchema } },
		},
		...errorResponses,
	},
});

projectRoute.openapi(getProjectVersioningRoute, async (context) =>
	context.json(await getProjectVersioningStatus(), 200),
);

const enableProjectVersioningRoute = createRoute({
	method: "post",
	path: "/project/versioning/enable",
	request: { body: { content: { "application/json": { schema: ProjectVersioningToggleBodySchema } } } },
	responses: {
		200: {
			description: "Enable shared automatic agents.yaml versions and create a baseline when needed",
			content: { "application/json": { schema: ProjectVersioningStatusSchema } },
		},
		...errorResponses,
	},
});

projectRoute.openapi(enableProjectVersioningRoute, async (context) => {
	const { base_revision: baseRevision } = context.req.valid("json");
	return context.json(await setProjectVersioning({ baseRevision, enabled: true }), 200);
});

const disableProjectVersioningRoute = createRoute({
	method: "post",
	path: "/project/versioning/disable",
	request: { body: { content: { "application/json": { schema: ProjectVersioningToggleBodySchema } } } },
	responses: {
		200: {
			description: "Disable shared automatic agents.yaml versions without removing snapshots",
			content: { "application/json": { schema: ProjectVersioningStatusSchema } },
		},
		...errorResponses,
	},
});

projectRoute.openapi(disableProjectVersioningRoute, async (context) => {
	const { base_revision: baseRevision } = context.req.valid("json");
	return context.json(await setProjectVersioning({ baseRevision, enabled: false }), 200);
});

const listProjectVersionsRoute = createRoute({
	method: "get",
	path: "/project/versions",
	request: { query: ProjectVersionsQuerySchema },
	responses: {
		200: {
			description: "Local directory source snapshots",
			content: { "application/json": { schema: ProjectVersionsResponseSchema } },
		},
		...errorResponses,
	},
});

projectRoute.openapi(listProjectVersionsRoute, async (context) => {
	const { cursor, limit } = context.req.valid("query");
	return context.json(await listProjectVersions({ cursor, limit }), 200);
});

const previewProjectVersionRoute = createRoute({
	method: "post",
	path: "/project/versions/{versionId}/preview",
	request: {
		params: ProjectVersionParamsSchema,
		body: { content: { "application/json": { schema: ProjectVersionActionBodySchema } } },
	},
	responses: {
		200: {
			description: "Validate and preview restoring a historical directory source tree",
			content: { "application/json": { schema: ProjectVersionPreviewSchema } },
		},
		...errorResponses,
	},
});

projectRoute.openapi(previewProjectVersionRoute, async (context) => {
	const { versionId } = context.req.valid("param");
	const { base_revision: baseRevision, base_head_version: baseHeadVersion } = context.req.valid("json");
	return context.json(await previewProjectVersion({ versionId, baseRevision, baseHeadVersion }), 200);
});

const restoreProjectVersionRoute = createRoute({
	method: "post",
	path: "/project/versions/{versionId}/restore",
	request: {
		params: ProjectVersionParamsSchema,
		body: { content: { "application/json": { schema: ProjectVersionActionBodySchema } } },
	},
	responses: {
		200: {
			description: "Restore historical directory source without changing version history or remote State",
			content: { "application/json": { schema: ProjectVersionRestoreResponseSchema } },
		},
		...errorResponses,
	},
});

projectRoute.openapi(restoreProjectVersionRoute, async (context) => {
	const { versionId } = context.req.valid("param");
	const { base_revision: baseRevision, base_head_version: baseHeadVersion } = context.req.valid("json");
	return context.json(await restoreProjectVersion({ versionId, baseRevision, baseHeadVersion }), 200);
});

const previewProjectBuildRoute = createRoute({
	method: "post",
	path: "/project/build/preview",
	request: { body: { content: { "application/json": { schema: ProjectBuildBodySchema } } } },
	responses: {
		200: {
			description: "Preview deterministic directory-project Build output and organization moves",
			content: { "application/json": { schema: ProjectBuildResponseSchema } },
		},
		...errorResponses,
	},
});

projectRoute.openapi(previewProjectBuildRoute, async (context) => {
	const { base_revision: baseRevision } = context.req.valid("json");
	const preview = await previewProjectBuild(projectRuntimeManager.projectRoot);
	if (preview.project_revision !== baseRevision) throw statusError("Project files changed. Preview Build again.", 409);
	return context.json(buildForWire(preview), 200);
});

const commitProjectBuildRoute = createRoute({
	method: "post",
	path: "/project/build",
	request: { body: { content: { "application/json": { schema: ProjectBuildBodySchema } } } },
	responses: {
		200: {
			description: "Organize directory source and atomically write the generated Build",
			content: { "application/json": { schema: ProjectBuildResponseSchema } },
		},
		...errorResponses,
	},
});

projectRoute.openapi(commitProjectBuildRoute, async (context) => {
	const { base_revision: baseRevision } = context.req.valid("json");
	const lease = projectMutationCoordinator.acquire("project_build");
	try {
		const result = await commitProjectBuild({ projectRoot: projectRuntimeManager.projectRoot, baseRevision });
		await projectRuntimeManager.refreshAfterSourceMutation();
		planTokenStore.invalidateAll();
		return context.json(buildForWire(result, result.manifest), 200);
	} finally {
		lease.release();
	}
});

const planProjectRoute = createRoute({
	method: "post",
	path: "/project/plan",
	request: { body: { content: { "application/json": { schema: ProjectPlanBodySchema } } } },
	responses: {
		200: {
			description: "Plan every resource in the current project Build",
			content: { "application/json": { schema: ProjectPlanResponseSchema } },
		},
		...errorResponses,
	},
});

projectRoute.openapi(planProjectRoute, async (context) => {
	await projectRuntimeManager.ensureStarted();
	await readValidProjectBuild(projectRuntimeManager.projectRoot);
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
			description: "Accept a full project Publish and version its frozen directory source after success",
			content: { "application/json": { schema: ProjectApplyResponseSchema } },
		},
		...errorResponses,
	},
});

projectRoute.openapi(applyProjectRoute, async (context) => {
	await projectRuntimeManager.ensureStarted();
	await readValidProjectBuild(projectRuntimeManager.projectRoot);
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
	const versionMessage = `Publish project revision ${token.projectRevision.slice(0, 12)}`;
	const input = projectRuntimeManager.requireRuntimeInput();
	const lease = projectMutationCoordinator.acquire("project_apply");
	let preparedVersion: Awaited<ReturnType<typeof prepareProjectVersionForApply>> | null = null;
	let operation: ReturnType<typeof projectOperationStore.create>;
	try {
		preparedVersion = await prepareProjectVersionForApply({ baseRevision: token.projectRevision });
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
				await releaseProjectVersionAfterApply(preparedVersion);
				lease.release();
			}
		});
		lease.setOperationId(operation.id);
	} catch (error) {
		await releaseProjectVersionAfterApply(preparedVersion);
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
			description: "Accept a compatibility-scoped Agent apply without creating a project version",
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
	const lease = projectMutationCoordinator.acquire("agent_apply");
	let filesystemLease: Awaited<ReturnType<typeof acquireDirectoryProjectMutation>> | undefined;
	let operation: ReturnType<typeof projectOperationStore.create>;
	try {
		filesystemLease = await acquireDirectoryProjectMutation(projectRuntimeManager.projectRoot, "agent_apply");
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
				planTokenStore.invalidateAll();
				await projectRuntimeManager.refreshAfterMutation();
				return redactForWire(run);
			} finally {
				await filesystemLease?.release();
				lease.release();
			}
		});
		lease.setOperationId(operation.id);
	} catch (error) {
		await filesystemLease?.release();
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

function buildForWire(
	preview: Awaited<ReturnType<typeof previewProjectBuild>>,
	manifest?: Awaited<ReturnType<typeof commitProjectBuild>>["manifest"],
) {
	return {
		project_revision: preview.project_revision,
		before_yaml: preview.before_yaml,
		after_yaml: preview.after_yaml,
		diagnostics: redactForWire(preview.diagnostics),
		warnings: redactForWire(preview.warnings),
		organization_moves: preview.organization_moves,
		can_build: preview.can_build,
		...(manifest ? { manifest } : {}),
	};
}
