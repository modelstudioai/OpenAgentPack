import type { CloudAgent, CloudEnvironment, CloudVault, Session } from "@openagentpack/sdk";
import type { UploadedFile } from "../file-api";
import type { SkillSummary } from "../skill-api";

// How a cloud agent's identity is stamped in metadata:
//   · "playbook" — current app-created, carries metadata.app_id + metadata.playbook_id
//   · "agents"   — SDK/`bl`-deploy created, carries agents.project/agents.resource but no current-app
//               playbook key → webui can't resolve it authoritatively; an orphan/duplicate risk
//   · "none"  — neither stamp present
export type IdentityStamp = "playbook" | "agents" | "none";

export interface ResourceAgentRow {
	id: string;
	name: string;
	description?: string;
	model?: string;
	version?: number;
	createdAt?: string;
	updatedAt?: string;
	identity: IdentityStamp;
	/** Playbook id this agent maps to: by app/playbook metadata, or by name for agents.* orphans. */
	playbookSlug?: string;
	/** Playbook display name (役 role) for annotation; undefined when unrecognized. */
	playbookName?: string;
	/** True when the playbook was inferred from the display name, not a metadata stamp. */
	playbookInferred: boolean;
	/** True when another cloud agent shares the exact same display name. */
	duplicate: boolean;
	taskCount: number;
	raw: CloudAgent;
}

export interface MissingPlaybookRow {
	slug: string;
	name: string;
	playbookName: string;
}

export interface ResourceEnvRow {
	id: string;
	name: string;
	description?: string;
	/** True for the managed base sandbox (name Agents/base + agents.base stamp) sessions run in. */
	isBase: boolean;
	/** config.networking.type, read defensively (cloud config is untyped, often partial). */
	networking?: string;
	/** config.packages.npm — bailian-cli here is load-bearing (installs `bl`). */
	packages: string[];
	version?: number;
	scope?: string;
	createdAt?: string;
	updatedAt?: string;
	raw: CloudEnvironment;
}

export interface ResourceVaultRow {
	id: string;
	/** display_name — the base-vault identity (Agents/secrets); a vault has no `name` field. */
	name: string;
	createdAt?: string;
	updatedAt?: string;
	raw: CloudVault;
}

export interface ResourceFileRow {
	id: string;
	/** Display name with the Agents__ isolation prefix stripped — what the user originally uploaded. */
	name: string;
	/** Raw stored filename (prefix intact), needed for any keyed operation. */
	filename: string;
	mimeType?: string;
	sizeBytes?: number;
	status?: UploadedFile["status"];
	/** Bindable-to-session flag (derived per-wire); false while the provider scan is in flight. */
	available?: boolean;
	createdAt?: string;
	raw: UploadedFile;
}

export interface ResourceSkillRow {
	id: string;
	/** Display name with the Agents__ isolation prefix stripped — what the user originally uploaded. */
	name: string;
	source: SkillSummary["source"];
	status: SkillSummary["status"];
	latestVersion?: string;
	createdAt?: string;
	updatedAt?: string;
	raw: SkillSummary;
}

export type ReferencedSkillStatus = "declared" | SkillSummary["status"] | "missing";

export interface ReferencedSkillRow {
	key: string;
	name: string;
	type: SkillSummary["source"];
	/** Playbook ids that declare this skill. */
	declaredBy: string[];
	status: ReferencedSkillStatus;
	providerCode?: string;
	latestVersion?: string;
	url?: string;
	raw?: SkillSummary;
}

export type ReferencedMcpStatus = "declared" | "attached" | "partial" | "missing" | "extra";

export interface ReferencedMcpRow {
	key: string;
	name: string;
	type: "official" | "custom";
	url?: string;
	/** Playbook ids that declare this MCP server. Empty for cloud-only extras. */
	declaredBy: string[];
	/** Current-app cloud agents that already carry this MCP server. */
	attachedAgents: string[];
	/** Current-app cloud agents for declaring playbooks that do not carry this MCP server. */
	missingAgents: string[];
	status: ReferencedMcpStatus;
}

export interface ResourceCenterView {
	agents: ResourceAgentRow[];
	missing: MissingPlaybookRow[];
	metrics: {
		cloudAgentCount: number;
		playbookCovered: number;
		playbookTotal: number;
		duplicateGroups: number;
		orphanCount: number;
		totalTasks: number;
		skillCount: number;
	};
	duplicateNames: string[];
	/** This project's sessions (the Agents agent family's), newest first. */
	sessions: Session[];
	/** Org-scoped cloud environments (the shared sandboxes), managed base first. */
	environments: ResourceEnvRow[];
	/** Remote id of the managed base sandbox, if it exists. */
	baseEnvironmentId?: string;
	/** This project's credential vaults (the managed base vault holding DASHSCOPE_API_KEY). */
	vaults: ResourceVaultRow[];
	/** Remote id of the managed base vault, if it exists. */
	baseVaultId?: string;
	/** This project's uploaded files (Agents__-prefixed), newest first. */
	files: ResourceFileRow[];
	/** Workspace custom skills, newest first. */
	skills: ResourceSkillRow[];
	/** The provider's built-in (official) skill catalog. Read-only; shown in the official tab. */
	officialSkills: ResourceSkillRow[];
	/** Skills declared by current playbooks, joined to the workspace/provider catalog. */
	referencedSkills: ReferencedSkillRow[];
	/** MCP servers declared by current playbooks, joined to current-app cloud agents. */
	referencedMcpServers: ReferencedMcpRow[];
}

export type PlaybookAgentRelationStatus = "ready" | "missing" | "duplicate" | "drifted";
export type PlaybookDependencyStatus = "none" | "ready" | "pending" | "problem";
export type PlaybookMcpStatus = "none" | "ready" | "pending" | "drifted";
export type PlaybookResourceStatus = "ready" | "missing-agent" | "degraded" | "drifted";

export interface PlaybookSkillDependency {
	key: string;
	name: string;
	type: ReferencedSkillRow["type"];
	status: ReferencedSkillRow["status"];
	providerCode?: string;
	latestVersion?: string;
}

export interface PlaybookMcpDependency {
	key: string;
	name: string;
	type: ReferencedMcpRow["type"];
	status: "attached" | "missing" | "pending";
	attachedCount: number;
	missingCount: number;
}

export interface PlaybookResourceRow {
	playbookId: string;
	playbookName: string;
	agentName: string;
	agent: {
		status: PlaybookAgentRelationStatus;
		label: string;
		agents: ResourceAgentRow[];
		primary?: ResourceAgentRow;
	};
	sessions: {
		count: number;
		latest?: Session;
		label: string;
	};
	skills: {
		status: PlaybookDependencyStatus;
		declared: number;
		available: number;
		pending: number;
		problematic: number;
		label: string;
		rows: PlaybookSkillDependency[];
	};
	mcp: {
		status: PlaybookMcpStatus;
		declared: number;
		attached: number;
		missing: number;
		label: string;
		rows: PlaybookMcpDependency[];
	};
	status: PlaybookResourceStatus;
	statusLabel: string;
	issues: string[];
}

export interface ResourceTopologyView {
	summary: {
		playbookTotal: number;
		readyPlaybooks: number;
		problemPlaybooks: number;
		missingAgentPlaybooks: number;
		skillProblemPlaybooks: number;
		mcpDriftPlaybooks: number;
		totalSessions: number;
	};
	playbooks: PlaybookResourceRow[];
	library: {
		files: number;
		customSkills: number;
		officialSkills: number;
		referencedSkills: number;
		referencedMcpServers: number;
	};
	runtime: {
		hasBaseEnvironment: boolean;
		hasBaseVault: boolean;
	};
}
