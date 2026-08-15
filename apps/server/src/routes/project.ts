import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { planAgentResourcesWithStateBackend, syncAgentResourcesWithStateBackend } from "@openagentpack/sdk";
import { errorResponses } from "@/schemas/common";
import {
	AgentApplyBodySchema,
	AgentApplyResponseSchema,
	AgentPlanBodySchema,
	AgentPlanResponseSchema,
	ProjectAgentParamsSchema,
	ProjectSummarySchema,
} from "@/schemas/project";
import { projectRuntimeManager } from "@/services/project-manager";
import { planTokenStore, projectOperationStore } from "@/services/project-operations";

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
	let ping: ReturnType<typeof setInterval> | undefined;
	const stream = new ReadableStream({
		start(controller) {
			const send = (type: string, data: unknown) => {
				controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
			};
			send("project.snapshot", {
				status: initial.status,
				revision: initial.revision,
			});
			unsubscribe = projectRuntimeManager.subscribe((event) => send(event.type, event));
			ping = setInterval(() => send("ping", {}), 15_000);
		},
		cancel() {
			unsubscribe?.();
			if (ping) clearInterval(ping);
		},
	});
	context.req.raw.signal.addEventListener("abort", () => {
		unsubscribe?.();
		if (ping) clearInterval(ping);
	});
	return new Response(stream, { headers: sseHeaders() });
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
		agentId,
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
			description: "Agent apply accepted as an asynchronous operation",
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
	const token = planTokenStore.require(planToken, agentId, snapshot.revision!);
	if (token.destructive && !confirmDestructive) {
		throw statusError(
			"This plan contains destructive actions. Set confirm_destructive to true after reviewing it.",
			422,
		);
	}

	const freshPlan = await planAgentResourcesWithStateBackend(input, agentId, {
		refresh: true,
		scope: "runtime",
	});
	if (freshPlan.fingerprint !== token.fingerprint) {
		planTokenStore.consume(planToken);
		throw statusError("Plan is stale because project or remote resources changed. Create a new plan.", 409);
	}
	const currentSnapshot = projectRuntimeManager.getSnapshot();
	try {
		planTokenStore.require(planToken, agentId, currentSnapshot.revision ?? "");
	} catch {
		planTokenStore.consume(planToken);
		throw statusError("Plan is stale because project configuration changed. Create a new plan.", 409);
	}

	const operation = projectOperationStore.create(agentId, async (reporter) => {
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
	});
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
