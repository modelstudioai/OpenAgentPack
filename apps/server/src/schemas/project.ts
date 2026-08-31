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

export const ProjectMutationSchema = z.object({
	kind: z.enum([
		"agent_apply",
		"project_apply",
		"project_build",
		"declaration_write",
		"version_enable",
		"version_write",
		"version_restore",
	]),
	started_at: z.string(),
	operation_id: z.string().optional(),
});

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
		active_mutation: ProjectMutationSchema.nullable(),
		build: z.object({
			exists: z.boolean(),
			stale: z.boolean(),
			reasons: z.array(z.string()),
			yaml_hash: z.string().optional(),
		}),
	})
	.openapi("ProjectSummary");

export const ProjectBuildBodySchema = z.object({ base_revision: z.string().min(1) });
export const ProjectBuildResponseSchema = z
	.object({
		project_revision: z.string(),
		before_yaml: z.string(),
		after_yaml: z.string(),
		diagnostics: z.array(DiagnosticSchema),
		warnings: z.array(DiagnosticSchema),
		organization_moves: z.array(
			z.object({ skill_id: z.string(), from: z.string(), to: z.string(), reason: z.literal("shared") }),
		),
		can_build: z.boolean(),
		manifest: z
			.object({
				schema_version: z.literal(1),
				project_revision: z.string(),
				source_manifest_hash: z.string(),
				yaml_hash: z.string(),
				built_at: z.string(),
			})
			.optional(),
	})
	.openapi("ProjectBuildResponse");

export const ProjectVersioningStatusSchema = z
	.object({
		initialized: z.boolean(),
		enabled: z.boolean(),
		store_root: z.string(),
		config_path: z.string(),
		head_version: z.string().nullable(),
		source_status: z.enum(["clean", "modified", "unversioned"]),
		source_versioned: z.boolean(),
		write_blockers: z.array(z.string()),
		restore_blockers: z.array(z.string()),
	})
	.openapi("ProjectVersioningStatus");
export const ProjectVersioningToggleBodySchema = z.object({ base_revision: z.string().min(1) });
export const ProjectVersionSchema = z
	.object({
		version_id: z.string(),
		short_version: z.string(),
		parent_version: z.string().nullable(),
		source_hash: z.string(),
		message: z.string(),
		created_by: z.string(),
		created_at: z.string(),
	})
	.openapi("ProjectVersion");
export const ProjectVersionsQuerySchema = z.object({
	cursor: z.string().optional(),
	limit: z.coerce.number().int().min(1).max(100).optional(),
});
export const ProjectVersionsResponseSchema = z
	.object({ versions: z.array(ProjectVersionSchema), next_cursor: z.string().nullable() })
	.openapi("ProjectVersionsResponse");
export const ProjectVersionParamsSchema = z.object({ versionId: z.string().min(1) });
export const ProjectVersionActionBodySchema = z.object({
	base_revision: z.string().min(1),
	base_head_version: z.string().min(1),
});
export const ProjectVersionPreviewSchema = z
	.object({
		version_id: z.string(),
		base_revision: z.string(),
		base_head_version: z.string(),
		before_yaml: z.string(),
		after_yaml: z.string(),
		changes: z.array(
			z.object({
				path: z.string(),
				change: z.enum(["create", "update", "delete"]),
				binary: z.boolean(),
				before: z.string().optional(),
				after: z.string().optional(),
			}),
		),
		diagnostics: z.array(DiagnosticSchema),
		can_restore: z.boolean(),
		blockers: z.array(z.string()),
	})
	.openapi("ProjectVersionPreview");
export const ProjectVersionRestoreResponseSchema = ProjectVersionPreviewSchema.extend({
	new_revision: z.string(),
}).openapi("ProjectVersionRestoreResponse");

export const ProjectAgentParamsSchema = z.object({ agentId: z.string().min(1) });

export const DeclarationTypeSchema = z.enum(["agent", "environment", "skill", "vault", "memory_store", "file"]);
export const DeclarationParamsSchema = z.object({
	type: DeclarationTypeSchema,
	id: z.string().min(1),
});
export const DeclarationPatchOperationSchema = z.object({
	op: z.enum(["set", "remove"]),
	path: z.array(z.string().min(1)).min(1),
	value: z.unknown().optional(),
});
export const DeclarationReferenceSchema = z.object({
	type: z.string(),
	id: z.string(),
	path: z.string(),
});
export const DeclarationResourceSchema = z.object({
	type: DeclarationTypeSchema,
	id: z.string(),
	declaration: z.record(z.string(), z.unknown()),
	read_only_paths: z.array(z.array(z.string())),
	references: z.array(DeclarationReferenceSchema),
});
export const ProjectDeclarationsResponseSchema = z
	.object({
		revision: z.string(),
		resources: z.array(DeclarationResourceSchema),
	})
	.openapi("ProjectDeclarationsResponse");
export const DeclarationPreviewBodySchema = z.object({
	base_revision: z.string().min(1),
	action: z.enum(["update", "delete"]),
	operations: z.array(DeclarationPatchOperationSchema).optional(),
});
export const DeclarationPatchBodySchema = z.object({
	base_revision: z.string().min(1),
	operations: z.array(DeclarationPatchOperationSchema).min(1),
});
export const DeclarationDeleteBodySchema = z.object({ base_revision: z.string().min(1) });
export const DeclarationPreviewResponseSchema = z
	.object({
		type: DeclarationTypeSchema,
		id: z.string(),
		action: z.enum(["update", "delete"]),
		base_revision: z.string(),
		before_yaml: z.string(),
		after_yaml: z.string(),
		diagnostics: z.array(DiagnosticSchema),
		references: z.array(DeclarationReferenceSchema),
		can_commit: z.boolean(),
	})
	.openapi("DeclarationPreviewResponse");
export const DeclarationCommitResponseSchema = DeclarationPreviewResponseSchema.extend({
	new_revision: z.string(),
}).openapi("DeclarationCommitResponse");

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

export const ProjectPlanBodySchema = z.object({ refresh: z.boolean().optional() });
export const ProjectPlanResponseSchema = z
	.object({
		scope: z.literal("project_runtime"),
		project_revision: z.string(),
		plan_token: z.string(),
		expires_at: z.string(),
		fingerprint: z.string(),
		actions: z.array(PlannedActionSchema),
		diagnostics: z.array(DiagnosticSchema),
		destructive: z.boolean(),
	})
	.openapi("ProjectPlanResponse");
export const ProjectApplyBodySchema = AgentApplyBodySchema;
export const ProjectApplyResponseSchema = AgentApplyResponseSchema.openapi("ProjectApplyResponse");

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
		type: z.enum(["agent.apply", "project.apply"]),
		agent_id: z.string().optional(),
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
