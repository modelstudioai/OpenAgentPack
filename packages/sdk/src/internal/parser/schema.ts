import { z } from "zod";

const networkingSchema = z.object({
	type: z.enum(["unrestricted", "limited"]),
	allow_mcp_servers: z.boolean().optional(),
	allow_package_managers: z.boolean().optional(),
	allowed_hosts: z.array(z.string()).optional(),
});

const packagesSchema = z.object({
	apt: z.array(z.string()).optional(),
	pip: z.array(z.string()).optional(),
	npm: z.array(z.string()).optional(),
	cargo: z.array(z.string()).optional(),
	gem: z.array(z.string()).optional(),
	go: z.array(z.string()).optional(),
});

const environmentSchema = z.object({
	name: z.string().optional(),
	description: z.string().optional(),
	provider: z.string().optional(),
	/** Pre-existing provider environment id (e.g. env_00xxxx). When set, the environment is treated as an external reference and will not be created/updated/deleted by OpenCMA. */
	environment_id: z.string().optional(),
	config: z.object({
		type: z.enum(["cloud", "self_hosted"]),
		networking: networkingSchema.optional(),
		packages: packagesSchema.optional(),
	}),
	metadata: z.record(z.string(), z.string()).optional(),
});

const tunnelSchema = z.object({
	name: z.string().optional(),
	description: z.string().optional(),
	/** Pre-existing Qoder tunnel id (e.g. tnl_00xxxx). Tunnels are allocated by Qoder BYOC admin and referenced, not created. */
	tunnel_id: z.string(),
	metadata: z.record(z.string(), z.string()).optional(),
});

const coerceString = z.union([z.string(), z.number()]).transform(String);

const staticBearerCredentialSchema = z.object({
	name: z.string(),
	type: z.literal("static_bearer"),
	mcp_server_url: z.string(),
	access_token: coerceString,
	protocol: z.enum(["sse", "streamable_http"]).optional(),
});

const environmentVariableCredentialSchema = z.object({
	name: z.string(),
	type: z.literal("environment_variable"),
	secret_name: z.string(),
	secret_value: coerceString,
	networking: z.object({ type: z.enum(["unrestricted", "limited"]) }).optional(),
});

const credentialSchema = z.discriminatedUnion("type", [
	staticBearerCredentialSchema,
	environmentVariableCredentialSchema,
]);

const vaultSchema = z.object({
	display_name: z.string(),
	provider: z.string().optional(),
	credentials: z.array(credentialSchema),
	metadata: z.record(z.string(), z.string()).optional(),
});

const memoryEntrySchema = z.object({
	key: z.string(),
	content: z.string(),
});

const memoryStoreSchema = z.object({
	description: z.string(),
	provider: z.string().optional(),
	metadata: z.record(z.string(), z.string()).optional(),
	entries: z.array(memoryEntrySchema).optional(),
});

const skillSchema = z.object({
	name: z.string().optional(),
	source: z.string(),
	description: z.string().optional(),
	version: z.string().optional(),
	origin: z.enum(["custom", "official"]).optional(),
	provider: z.string().optional(),
});

const fileSchema = z.object({
	source: z.string(),
	name: z.string().optional(),
	purpose: z.string().optional(),
	provider: z.string().optional(),
});

const managedIdentitySchema = z.object({
	provider: z.string().optional(),
	external_id: z.string().trim().min(1),
	name: z.string().trim().min(1).optional(),
	enabled: z.boolean().optional(),
	metadata: z.record(z.string(), z.string()).optional(),
	identity_id: z.never().optional(),
});

const externalIdentitySchema = z.object({
	provider: z.string().optional(),
	identity_id: z.string().trim().min(1),
	external_id: z.never().optional(),
	name: z.never().optional(),
	enabled: z.never().optional(),
	metadata: z.never().optional(),
});

const identitySchema = z.union([managedIdentitySchema, externalIdentitySchema]);

const urlMcpServerSchema = z
	.object({
		name: z.string(),
		type: z.enum(["url", "http"]).optional(),
		url: z.string(),
	})
	.transform((s) => ({
		...s,
		type: s.type ?? "url",
	}));

const officialMcpServerSchema = z.object({
	name: z.string(),
	type: z.literal("official"),
	url: z.string().optional(),
});

const mcpServerSchema = z.union([urlMcpServerSchema, officialMcpServerSchema]);

const toolEnabledSchema = z
	.object({
		name: z.string(),
		enabled: z.boolean().optional(),
	})
	.transform((t) => ({
		name: t.name,
		enabled: t.enabled ?? true,
	}));

const toolDefaultConfigSchema = z.object({
	enabled: z.boolean(),
});

const mcpToolkitSchema = z
	.object({
		type: z.literal("mcp_toolkit").optional(),
		mcp_server_name: z.string().optional(),
		mcpServerName: z.string().optional(),
		default_config: toolDefaultConfigSchema.optional(),
		defaultConfig: toolDefaultConfigSchema.optional(),
		configs: z.array(toolEnabledSchema).min(1),
	})
	.refine((t) => t.mcp_server_name !== undefined || t.mcpServerName !== undefined, {
		message: "Either mcp_server_name or mcpServerName is required",
	})
	.transform((t) => ({
		type: "mcp_toolkit" as const,
		mcp_server_name: t.mcp_server_name ?? t.mcpServerName!,
		default_config: t.default_config ?? t.defaultConfig ?? { enabled: false },
		configs: t.configs,
	}));

const toolsSchema = z.object({
	builtin: z.array(z.string()),
	mcp: z.array(mcpToolkitSchema).optional(),
	permissions: z.record(z.string(), z.enum(["allow", "ask"])).optional(),
});

const multiagentSchema = z.object({
	type: z.literal("coordinator"),
	agents: z.array(z.string()),
});

const agentSkillRefSchema = z
	.object({
		type: z.enum(["official", "custom"]),
		skill_id: z.union([z.string(), z.number()]).optional(),
		code: z.string().optional(),
		version: z.string().optional(),
	})
	.refine((s) => s.skill_id !== undefined || s.code !== undefined, {
		message: "Either skill_id or code is required",
	})
	.transform((s) => ({
		type: s.type,
		skill_id: String(s.skill_id ?? s.code),
		version: s.version,
	}));

const agentDeliverySchema = z.object({
	type: z.enum(["managed", "forward"]),
});

const agentSchema = z.object({
	name: z.string().optional(),
	description: z.string().optional(),
	model: z.union([z.string(), z.record(z.string(), z.string())]),
	instructions: z.string(),
	environment: z.string().optional(),
	tunnel: z.string().optional(),
	provider: z.string().optional(),
	tools: toolsSchema.optional(),
	mcp_servers: z.array(mcpServerSchema).optional(),
	skills: z.array(z.union([z.string(), agentSkillRefSchema])).optional(),
	vault: z.string().optional(),
	memory_stores: z.array(z.string()).optional(),
	multiagent: multiagentSchema.optional(),
	metadata: z.record(z.string(), z.string()).optional(),
	delivery: z.record(z.string(), agentDeliverySchema).optional(),
});

const channelSchema = z.object({
	provider: z.string().optional(),
	agent: z.string().min(1),
	identity: z.string().min(1).optional(),
	type: z.string().min(1),
	name: z.string().trim().min(1).optional(),
	enabled: z.boolean().optional(),
	credentials: z.record(z.string(), coerceString).optional(),
	options: z.record(z.string(), z.unknown()).optional(),
});

const deploymentFileResourceSchema = z.object({
	type: z.literal("file"),
	file_id: z.string().optional(),
	source: z.string().optional(),
	mount_path: z.string().optional(),
});

const deploymentMemoryStoreResourceSchema = z.object({
	type: z.literal("memory_store"),
	memory_store: z.string(),
	access: z.enum(["read_write", "read_only"]).optional(),
	instructions: z.string().optional(),
});

const deploymentGithubRepoResourceSchema = z.object({
	type: z.literal("github_repository"),
	url: z.string(),
	checkout: z.object({ branch: z.string().optional(), commit: z.string().optional() }).optional(),
	mount_path: z.string().optional(),
	authorization_token: z.string().optional(),
});

const deploymentResourceSchema = z.discriminatedUnion("type", [
	deploymentFileResourceSchema,
	deploymentMemoryStoreResourceSchema,
	deploymentGithubRepoResourceSchema,
]);

const initialEventSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("user.message"), content: z.string() }),
	z.object({ type: z.literal("system.message"), content: z.string() }),
	z.object({
		type: z.literal("user.define_outcome"),
		description: z.string().optional(),
		rubric: z.string().optional(),
		rubric_file: z.string().optional(),
		max_iterations: z.number().int().min(1).max(20).optional(),
	}),
]);

const scheduleSchema = z.object({
	expression: z.string().refine((s) => s.trim().split(/\s+/).length === 5, {
		message: "schedule.expression must be a 5-field cron expression",
	}),
	timezone: z.string(),
});

const deploymentSchema = z.object({
	agent: z.string(),
	agent_version: z.number().int().optional(),
	environment: z.string().optional(),
	tunnel: z.string().optional(),
	vaults: z.array(z.string()).optional(),
	memory_stores: z.array(z.string()).optional(),
	resources: z.array(deploymentResourceSchema).optional(),
	initial_events: z.array(initialEventSchema).min(1).max(50),
	schedule: scheduleSchema.optional(),
	description: z.string().optional(),
	provider: z.string().optional(),
	metadata: z.record(z.string(), z.string()).optional(),
	environment_variables: z.string().optional(),
});

export const projectConfigSchema = z.object({
	version: z.string(),
	providers: z.record(z.string(), z.unknown()),
	defaults: z
		.object({
			provider: z.string().optional(),
			identity: z.string().min(1).optional(),
		})
		.optional(),
	environments: z.record(z.string(), environmentSchema).optional(),
	tunnels: z.record(z.string(), tunnelSchema).optional(),
	vaults: z.record(z.string(), vaultSchema).optional(),
	memory_stores: z.record(z.string(), memoryStoreSchema).optional(),
	skills: z.record(z.string(), skillSchema).optional(),
	files: z.record(z.string(), fileSchema).optional(),
	identities: z.record(z.string(), identitySchema).optional(),
	agents: z.record(z.string(), agentSchema).optional(),
	channels: z.record(z.string(), channelSchema).optional(),
	deployments: z.record(z.string(), deploymentSchema).optional(),
});

export type ParsedConfig = z.infer<typeof projectConfigSchema>;
