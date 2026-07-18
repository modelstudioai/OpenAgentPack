import type { CloudAgent, CloudEnvironment, CloudVault } from "../types/dto.ts";
import type { ProviderFileInfo } from "../types/file.ts";
import type { ProviderSessionInfo } from "../types/session.ts";
import type { ProviderSkillInfo } from "../types/skill-info.ts";
import type { ResourceType } from "../types/state.ts";
import { ApiError, type BaseApiClient } from "./base-client.ts";
import type { ExportedResource } from "./interface.ts";
import { extractVaultIds } from "./session-vault.ts";
import { resourceNameFromMetadata } from "./sync-mapping.ts";

/**
 * The fetch core shared by findResource and readComparableResource across all
 * providers. With `id`, verify precisely via the detail endpoint
 * (`GET /{endpoint}/{id}`, 404 → null, other errors rethrown). Without `id`,
 * walk every page and match by `name`. `accept` is an optional filter (e.g.
 * bailian drops archived agents) applied on both paths. Returns the raw remote
 * object so callers can shape it (RemoteResource vs comparable). `endpoint`
 * undefined means the type is unsupported on this provider → null.
 */
export async function locateRemote(
	client: BaseApiClient,
	endpoint: string | undefined,
	name: string,
	id: string | null | undefined,
	accept?: (raw: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown> | null> {
	if (!endpoint) return null;
	const ok = accept ?? (() => true);

	if (id) {
		try {
			const raw = (await client.get(`${endpoint}/${id}`)) as Record<string, unknown>;
			return ok(raw) ? raw : null;
		} catch (err) {
			if (ApiError.isNotFound(err)) return null;
			throw err;
		}
	}

	const all = await client.getAllPaged(endpoint);
	return all.find((r) => r.name === name && ok(r)) ?? null;
}

/**
 * Assemble the neutral ProviderSessionInfo shared by every provider's
 * toSessionInfo. agent_id tolerates both the embedded `agent.id` (claude /
 * bailian / qoder) and a flat `agent_id` (qoder list responses). memory_store
 * extraction is the only genuine variance, injected as `memoryStoreIds`.
 */
export function buildSessionInfo(
	res: Record<string, unknown>,
	memoryStoreIds: (res: Record<string, unknown>) => string[],
): ProviderSessionInfo {
	const agent = res.agent as Record<string, unknown> | undefined;
	return {
		id: res.id as string,
		agent_id: (agent?.id as string) ?? (res.agent_id as string) ?? "",
		environment_id: res.environment_id as string,
		tunnel_id: (res.tunnel_id as string) ?? undefined,
		status: res.status as string,
		title: res.title as string | undefined,
		vault_ids: extractVaultIds(res),
		memory_store_ids: memoryStoreIds(res),
		created_at: res.created_at as string,
		updated_at: res.updated_at as string,
		attributes: res,
	};
}

export interface ExportMappers {
	envToDecl: (raw: Record<string, unknown>) => Record<string, unknown>;
	vaultToDecl: (
		raw: Record<string, unknown>,
		credentials: Array<Record<string, unknown>>,
		name: string,
	) => Record<string, unknown>;
	fileToDecl: (raw: Record<string, unknown>, filename: string) => Record<string, unknown>;
	skillToDecl: (raw: Record<string, unknown>, name: string) => Record<string, unknown>;
	agentToDecl: (raw: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * Reverse-map remote resources into agents.yaml declarations (used by `agents sync`).
 * The five branches are structurally identical across providers; only the
 * `*ToDecl` mappers and a few field names vary. Field picks use tolerant `??`
 * (each provider's field sets are disjoint, so the union is behaviour-preserving):
 * vault name `display_name ?? name`, file id `file_id ?? id`, skill display
 * `display_title ?? name ?? id`.
 */
export async function exportRemoteResources(
	client: BaseApiClient,
	type: ResourceType,
	mappers: ExportMappers,
): Promise<ExportedResource[]> {
	if (type === "environment") {
		const envs = await client.getAllPaged("/environments");
		return envs.map((env) => {
			const envId = env.id as string;
			const name = resourceNameFromMetadata(env.metadata, env.name as string, envId);
			return { name, decl: mappers.envToDecl(env) };
		});
	}
	if (type === "vault") {
		const vaults = await client.getAllPaged("/vaults");
		const out: ExportedResource[] = [];
		for (const vault of vaults) {
			const vaultId = vault.id as string;
			const credentials = await client.getAllPaged(`/vaults/${vaultId}/credentials`);
			const name = resourceNameFromMetadata(vault.metadata, (vault.display_name ?? vault.name) as string, vaultId);
			out.push({ name, decl: mappers.vaultToDecl(vault, credentials, name) });
		}
		return out;
	}
	if (type === "file") {
		const files = await client.getAllPaged("/files");
		return files.map((file) => {
			const fileId = (file.file_id ?? file.id) as string;
			const filename = (file.filename as string) ?? fileId;
			const name = resourceNameFromMetadata(file.metadata, filename, fileId);
			return { name, decl: mappers.fileToDecl(file, filename) };
		});
	}
	if (type === "skill") {
		const skills = await client.getAllPaged("/skills");
		return skills.map((skill) => {
			const skillId = skill.id as string;
			const name = resourceNameFromMetadata(skill.metadata, (skill.display_title ?? skill.name) as string, skillId);
			return { name, decl: mappers.skillToDecl(skill, name) };
		});
	}
	if (type === "agent") {
		const agents = await client.getAllPaged("/agents");
		return agents
			.filter((agent) => !agent.archived_at)
			.map((agent) => {
				const agentId = agent.id as string;
				return { name: agentId, decl: mappers.agentToDecl(agent) };
			});
	}
	return [];
}

/** Keep only string-valued metadata entries (the neutral CloudResource metadata is string→string). */
function pickStringMetadata(raw: unknown): Record<string, string> | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
		if (typeof v === "string") out[k] = v;
	}
	return out;
}

/**
 * Raw provider `/agents` list item → neutral CloudAgent. Every provider returns
 * snake_case for these fields (managed-agents, qoder REST, and bailian OpenAPI all
 * agree), so this is a field-pick with no per-provider variance. tools/skills/
 * mcp_servers pass through raw — the resource center classifies on metadata/name/
 * timestamps, not tool internals.
 */
export function toCloudAgent(raw: Record<string, unknown>): CloudAgent {
	return {
		id: raw.id as string,
		name: raw.name as string | undefined,
		description: raw.description as string | undefined,
		model: raw.model,
		system: raw.system as string | undefined,
		tools: raw.tools,
		skills: raw.skills,
		mcp_servers: raw.mcp_servers,
		metadata: pickStringMetadata(raw.metadata),
		version: typeof raw.version === "number" ? raw.version : undefined,
		type: raw.type as string | undefined,
		workspace_id: raw.workspace_id as string | undefined,
		created_at: raw.created_at as string | undefined,
		updated_at: raw.updated_at as string | undefined,
		archived_at: (raw.archived_at as string | null | undefined) ?? null,
	};
}

/** Raw provider `/environments` list item (snake_case across providers) → neutral CloudEnvironment. */
export function toCloudEnvironment(raw: Record<string, unknown>): CloudEnvironment {
	return {
		id: raw.id as string,
		name: raw.name as string | undefined,
		description: raw.description as string | undefined,
		config: raw.config,
		metadata: pickStringMetadata(raw.metadata),
		scope: raw.scope as string | undefined,
		version: typeof raw.version === "number" ? raw.version : undefined,
		type: raw.type as string | undefined,
		workspace_id: raw.workspace_id as string | undefined,
		created_at: raw.created_at as string | undefined,
		updated_at: raw.updated_at as string | undefined,
		archived_at: (raw.archived_at as string | null | undefined) ?? null,
	};
}

/** Raw provider `/vaults` list item (snake_case across providers) → neutral CloudVault. */
export function toCloudVault(raw: Record<string, unknown>): CloudVault {
	return {
		id: raw.id as string,
		display_name: raw.display_name as string | undefined,
		metadata: pickStringMetadata(raw.metadata),
		type: raw.type as string | undefined,
		created_at: (raw.created_at as string | null | undefined) ?? null,
		updated_at: (raw.updated_at as string | null | undefined) ?? null,
		archived_at: (raw.archived_at as string | null | undefined) ?? null,
	};
}

/**
 * Raw provider file object → neutral ProviderFileInfo. `file_id ?? id` tolerates
 * qoder (which returns `file_id`) alongside claude/bailian (`id`); the optional
 * downloadable/status/purpose picks are each provider's disjoint extras.
 */
export function toRestFileInfo(res: Record<string, unknown>): ProviderFileInfo {
	return {
		id: (res.file_id ?? res.id) as string,
		filename: res.filename as string,
		mime_type: res.mime_type as string,
		size_bytes: res.size_bytes as number,
		created_at: res.created_at as string,
		downloadable: res.downloadable as boolean | undefined,
		status: res.status as string | undefined,
		purpose: res.purpose as string | undefined,
	};
}

/**
 * Raw REST skill object → neutral ProviderSkillInfo, shared by the providers whose
 * skills wire is identical (claude, qoder): name comes from `display_title`, and the
 * catalog is `custom` unless the item's `source` says otherwise (qoder returns its own
 * `qoder` marker for the built-in catalog, which maps to `official`). These providers
 * expose no scan status, so a listed skill is always usable → `active`. Bailian differs
 * (name `name`, source `customer`, real scan status) and keeps its own mapper.
 */
export function toRestSkillInfo(res: Record<string, unknown>): ProviderSkillInfo {
	const rawSource = String(res.source ?? "").toLowerCase();
	return {
		id: res.id as string,
		name: (res.display_title as string) ?? (res.name as string) ?? "",
		description: res.description as string | undefined,
		source: rawSource === "custom" ? "custom" : "official",
		status: "active",
		latest_version: res.latest_version as string | undefined,
		created_at: res.created_at as string | undefined,
		updated_at: res.updated_at as string | undefined,
	};
}
