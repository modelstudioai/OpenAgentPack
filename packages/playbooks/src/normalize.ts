import {
	AVATAR_PATH_METADATA_KEY,
	DEFAULT_LOCALE,
	DISPLAY_NAME_METADATA_PREFIX,
	PLAYBOOK_APP_METADATA_KEY,
	SAMPLE_PROMPT_METADATA_PREFIX,
	TEMPLATE_ID_METADATA_KEY,
} from "./metadata.ts";
import type { AgentSkillResource, LocalizedText, McpResource, PlaybookTemplate, ResourceOrigin } from "./types.ts";

/**
 * The raw Agent body as exported from the operator console (the sync extension's `agents.json`).
 * Display lives in flat, locale-suffixed `metadata` keys; the unique template id lives in
 * `metadata.template_id`; builtin tools are nested inside `tools[].configs`. `normalizePlaybookTemplate`
 * is the single point that maps this wire shape into the runtime `PlaybookTemplate`.
 */
export interface SourceAgent {
	/** Backend agent id (e.g. `agent_xxx`). Optional fallback when `metadata.template_id` is absent. */
	id?: string;
	name?: string;
	system: string;
	model: string | { id: string; name?: string };
	version?: number;
	metadata?: Record<string, string>;
	tools?: SourceTool[];
	skills?: SourceSkill[];
	mcpServers?: SourceMcp[];
	mcp_servers?: SourceMcp[];
}

interface SourceTool {
	type?: string;
	configs?: { name: string; enabled?: boolean }[];
}

interface SourceSkill {
	id?: string;
	code?: string;
	name?: string;
	type?: string;
	version?: string;
	url?: string;
}

interface SourceMcp {
	id?: string;
	name: string;
	type: ResourceOrigin;
	url?: string;
}

/** Build a locale-keyed value from flat `${prefix}${locale}` metadata keys; undefined when none present. */
function localizedFromMetadata(metadata: Record<string, string>, prefix: string): LocalizedText | undefined {
	const out: LocalizedText = {};
	for (const [key, value] of Object.entries(metadata)) {
		if (!key.startsWith(prefix)) continue;
		const locale = key.slice(prefix.length);
		if (locale && typeof value === "string" && value.trim()) out[locale] = value;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

/** Flatten builtin_toolkit configs into the enabled tool-name list, preserving order. */
function flattenBuiltinTools(tools: SourceTool[]): string[] {
	const names: string[] = [];
	for (const tool of tools) {
		if (tool.type !== "builtin_toolkit") continue;
		for (const config of tool.configs ?? []) {
			if (config.enabled && config.name && !names.includes(config.name)) names.push(config.name);
		}
	}
	return names;
}

function normalizeOrigin(type: string | undefined): ResourceOrigin {
	return type === "official" ? "official" : "custom";
}

function normalizeSkill(skill: SourceSkill): AgentSkillResource {
	const type = normalizeOrigin(skill.type);
	const id = (type === "official" ? skill.code || skill.id || skill.name : skill.name || skill.code || skill.id) ?? "";
	return {
		id,
		type,
		...(skill.name ? { name: skill.name } : {}),
		...(skill.version ? { version: skill.version } : {}),
		...(skill.url ? { url: skill.url } : {}),
	};
}

function normalizeMcp(server: SourceMcp): McpResource {
	return {
		id: server.id || server.name,
		name: server.name,
		type: server.type,
		...(server.url ? { url: server.url } : {}),
	};
}

/**
 * Map a raw console-exported Agent into a runtime `PlaybookTemplate`.
 *
 * Rules:
 *  - Unique id: `metadata.template_id` when present, else the backend `id`. Entries with neither
 *    are dropped (null) — a playbook with no resolvable identity is unusable.
 *  - Display fields come from `metadata` only (display_name_, sample_prompt_, avatar_url); never invented.
 *  - Agents carrying an `app_id` stamp are runtime artefacts (webui dogfooding) and are dropped (null).
 */
export function normalizePlaybookTemplate(raw: SourceAgent): PlaybookTemplate | null {
	const metadata = raw.metadata ?? {};
	if (metadata[PLAYBOOK_APP_METADATA_KEY]) return null;

	const id = metadata[TEMPLATE_ID_METADATA_KEY]?.trim() || raw.id?.trim();
	if (!id) return null;
	const displayName = localizedFromMetadata(metadata, DISPLAY_NAME_METADATA_PREFIX) ?? { [DEFAULT_LOCALE]: id };
	const samplePrompt = localizedFromMetadata(metadata, SAMPLE_PROMPT_METADATA_PREFIX);
	const imageUrl = metadata[AVATAR_PATH_METADATA_KEY]?.trim();

	const model =
		typeof raw.model === "string"
			? { id: raw.model }
			: { id: raw.model.id, ...(raw.model.name ? { name: raw.model.name } : {}) };

	return {
		id,
		displayName,
		...(samplePrompt ? { samplePrompt } : {}),
		system: raw.system,
		model,
		builtinTools: flattenBuiltinTools(raw.tools ?? []),
		skills: (raw.skills ?? []).map(normalizeSkill),
		mcpServers: (raw.mcpServers ?? raw.mcp_servers ?? []).map(normalizeMcp),
		version: raw.version ?? 1,
		...(imageUrl ? { imageUrl } : {}),
	};
}

/** Normalize a batch of raw exports, dropping runtime artefacts (app_id-stamped). */
export function normalizePlaybookTemplates(raws: SourceAgent[]): PlaybookTemplate[] {
	return raws.map(normalizePlaybookTemplate).filter((template): template is PlaybookTemplate => template !== null);
}
