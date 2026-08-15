import { z } from "@hono/zod-openapi";
import {
	AgentDefinitionSchema,
	AgentWithReadinessSchema,
	DiagnosticSchema,
	PlannedActionSchema,
	SessionEventSchema,
	SessionSchema,
} from "@openagentpack/sdk";

export const ProjectStatusSchema = z.enum(["loading", "valid", "invalid", "missing"]);

export const ProjectAgentSummarySchema = AgentWithReadinessSchema.extend({
	details: z.object({
		environment: z.string().optional(),
		vault: z.string().optional(),
		memory_stores: z.array(z.string()),
		resources: z.array(z.object({ type: z.string(), mount_path: z.string().optional() })),
	}),
});

export const ProjectDeploymentSummarySchema = z.object({
	id: z.string(),
	agent: z.string(),
	provider: z.string().optional(),
	description: z.string().optional(),
	schedule: z.object({ expression: z.string(), timezone: z.string() }).optional(),
	initial_event_types: z.array(z.string()),
	resource_types: z.array(z.string()),
});

export const ProjectSummarySchema = z
	.object({
		status: ProjectStatusSchema,
		config_file: z.string(),
		project_name: z.string(),
		revision: z.string().optional(),
		diagnostics: z.array(DiagnosticSchema),
		agents: z.array(ProjectAgentSummarySchema),
		deployments: z.array(ProjectDeploymentSummarySchema),
	})
	.openapi("ProjectSummary");

export const ProjectAgentParamsSchema = z.object({ agentId: z.string().min(1) });

export const AgentPlanBodySchema = z.object({ refresh: z.boolean().optional() });

export const AgentPlanResponseSchema = z
	.object({
		agent_id: z.string(),
		provider: z.string(),
		project_revision: z.string(),
		plan_token: z.string(),
		expires_at: z.string(),
		fingerprint: z.string(),
		actions: z.array(PlannedActionSchema),
		diagnostics: z.array(DiagnosticSchema),
		destructive: z.boolean(),
	})
	.openapi("AgentPlanResponse");

export const AgentApplyBodySchema = z.object({
	plan_token: z.string().min(1),
	confirm_destructive: z.boolean().optional(),
});

export const AgentApplyResponseSchema = z
	.object({ operation_id: z.string(), status: z.literal("queued") })
	.openapi("AgentApplyResponse");

export const OperationStatusSchema = z.enum(["queued", "running", "completed", "failed", "interrupted"]);
export const OperationEventSchema = z.object({
	index: z.number().int().nonnegative(),
	type: z.string(),
	timestamp: z.string(),
	data: z.unknown(),
});
export const OperationResponseSchema = z
	.object({
		id: z.string(),
		type: z.literal("agent.apply"),
		agent_id: z.string(),
		status: OperationStatusSchema,
		created_at: z.string(),
		updated_at: z.string(),
		events: z.array(OperationEventSchema),
		result: z.unknown().optional(),
		error: z.string().optional(),
	})
	.openapi("OperationResponse");

export const OperationParamsSchema = z.object({ operationId: z.string().min(1) });
export const StreamAfterQuerySchema = z.object({
	after: z.preprocess((value) => {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}, z.number().int().optional()),
});

export const CreateProjectSessionBodySchema = z.object({
	prompt: z.string().optional(),
	title: z.string().optional(),
	attachment_ids: z.array(z.string()).optional(),
});
export const CreateProjectSessionResponseSchema = z
	.object({
		session: SessionSchema,
		events: z.array(SessionEventSchema),
		provider: z.string(),
		agent_id: z.string(),
		agent_name: z.string(),
		agent_details: AgentDefinitionSchema,
	})
	.openapi("CreateProjectSessionResponse");

export const SendProjectSessionMessageBodySchema = z.object({ message: z.string().min(1) });
export const ProjectSessionParamsSchema = z.object({ sessionId: z.string().min(1) });
export const ProjectSessionArtifactParamsSchema = ProjectSessionParamsSchema.extend({
	fileId: z.string().min(1),
});
export const ProjectSessionArtifactDownloadSchema = z
	.object({ url: z.string().url(), expires_at: z.string().optional() })
	.openapi("ProjectSessionArtifactDownload");

export const AttachmentSchema = z.object({
	id: z.string(),
	agent_id: z.string(),
	provider: z.string(),
	remote_file_id: z.string(),
	filename: z.string(),
	mime_type: z.string().optional(),
	status: z.string().optional(),
	available: z.boolean(),
	created_at: z.string(),
});
export const AttachmentListResponseSchema = z.object({ attachments: z.array(AttachmentSchema) });
export const AttachmentParamsSchema = z.object({ attachmentId: z.string().min(1) });
export const AttachmentDeleteResponseSchema = z.object({ attachment_id: z.string(), deleted: z.literal(true) });
