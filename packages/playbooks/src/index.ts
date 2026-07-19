import { getInfrastructure } from "./infrastructure.ts";
import bailianPlaybookJson from "./playbook/bailian.json";
import claudePlaybookJson from "./playbook/claude.json";
import arkPlaybookJson from "./playbook/ark.json";
import qoderPlaybookJson from "./playbook/qoder.json";
import { basePlaybook } from "./base-playbook.ts";
import {
	BASE_PLAYBOOK_ID,
	DEFAULT_LOCALE,
	DEFAULT_PLAYBOOK_APP_ID,
	DEFAULT_PLAYBOOK_PROVIDER,
	FALLBACK_LOCALE,
	PLAYBOOK_AGENT_NAME_PREFIX,
	PLAYBOOK_APP_METADATA_KEY,
	PLAYBOOK_METADATA_KEY,
	PROVIDER_DEFAULTS,
} from "./metadata.ts";
import { normalizePlaybookTemplates, type SourceAgent } from "./normalize.ts";
import { getPlaybookAgentName, resolvePlaybook, resolvePlaybookMcpServers, resolvePlaybookSkills } from "./resolve.ts";
import type {
	AgentSkillResource,
	EnvironmentProfile,
	Infrastructure,
	LocalizedText,
	PlaybookBundle,
	PlaybookCard,
	ResolvedPlaybook,
	PlaybookTemplate,
	VaultProfile,
} from "./types.ts";

export {
	BASE_PLAYBOOK_ID,
	DEFAULT_LOCALE,
	DEFAULT_PLAYBOOK_APP_ID,
	DEFAULT_PLAYBOOK_PROVIDER,
	FALLBACK_LOCALE,
	PLAYBOOK_AGENT_NAME_PREFIX,
	PLAYBOOK_APP_METADATA_KEY,
	PLAYBOOK_METADATA_KEY,
	PROVIDER_DEFAULTS,
};

export {
	getPlaybookAgentName,
	resolvePlaybook,
	resolvePlaybookMcpServers,
	resolvePlaybookModel,
	resolvePlaybookSkills,
} from "./resolve.ts";

export {
	createPlaybookSessionRuntime,
	pickPlaybookAgent,
	PlaybookAgentIdentityMismatchError,
	playbookIdentityMismatchMessage,
} from "./session-runtime.ts";

export type {
	AgentSkillResource,
	EnvironmentNetworking,
	EnvironmentPackages,
	EnvironmentProfile,
	Infrastructure,
	LocalizedText,
	McpResource,
	PlaybookBundle,
	PlaybookCard,
	ResolvedMcpServer,
	ResolvedPlaybook,
	ResolvedPlaybookAgentSpec,
	ResolvedPlaybookResourceRequirements,
	ResolvedSkill,
	ResourceOrigin,
	PlaybookTemplate,
	VaultCredentialStructure,
	VaultProfile,
} from "./types.ts";

export type {
	DeletePlaybookSessionInput,
	PlaybookAgentAdapter,
	PlaybookAgentPick,
	PlaybookProviderSessionAdapter,
	PlaybookSessionEventsAdapter,
	PlaybookSessionFile,
	PlaybookSessionRuntime,
	PlaybookSessionRuntimeAdapters,
	ProviderStartPlaybookSessionInput,
	RemotePlaybookAgent,
	SendPlaybookSessionInput,
	SentProviderPlaybookMessage,
	StartedProviderPlaybookSession,
	StartPlaybookSessionInput,
} from "./session-runtime.ts";

const PLAYBOOK_SOURCES: Record<string, SourceAgent[]> = {
	bailian: bailianPlaybookJson as SourceAgent[],
	claude: claudePlaybookJson as SourceAgent[],
	ark: arkPlaybookJson as SourceAgent[],
	qoder: qoderPlaybookJson as SourceAgent[],
};

/**
 * The bailian-cli official skill — only attached to playbooks running on the bailian provider,
 * where `bl` calls DashScope with the provider's own `DASHSCOPE_API_KEY`. Non-bailian providers do
 * NOT depend on bailian-cli (and must not be forced to obtain a rival vendor's key), so their
 * playbooks carry no bailian-cli skill.
 */
const BAILIAN_CLI_OFFICIAL_SKILL: AgentSkillResource = {
	type: "official",
	id: "skill_N2U0MDAwYWM2NDQ0NGFkNjljMz",
	version: "1.0",
};

function loadPlaybookTemplatesJson(provider: string): SourceAgent[] {
	return PLAYBOOK_SOURCES[provider] ?? (bailianPlaybookJson as SourceAgent[]);
}

function resolveBasePlaybook(provider: string): PlaybookTemplate {
	const skills: AgentSkillResource[] = provider === DEFAULT_PLAYBOOK_PROVIDER ? [BAILIAN_CLI_OFFICIAL_SKILL] : [];
	return {
		...basePlaybook,
		skills,
	};
}

function buildPlaybookBundle(provider: string): PlaybookBundle {
	const providerBasePlaybook = resolveBasePlaybook(provider);
	const infrastructure: Infrastructure = getInfrastructure(provider);
	return {
		playbookTemplates: [
			providerBasePlaybook,
			...normalizePlaybookTemplates(loadPlaybookTemplatesJson(provider)).filter(
				(template) => template.id !== providerBasePlaybook.id,
			),
		],
		infrastructure,
	};
}

const bundleCache = new Map<string, PlaybookBundle>();

export function getPlaybookBundle(provider: string = DEFAULT_PLAYBOOK_PROVIDER): PlaybookBundle {
	let bundle = bundleCache.get(provider);
	if (!bundle) {
		bundle = buildPlaybookBundle(provider);
		bundleCache.set(provider, bundle);
	}
	return bundle;
}

export function getPlaybookAppId(): string {
	return DEFAULT_PLAYBOOK_APP_ID;
}

/**
 * Resolve a locale-keyed display value via the chain: active locale → `en` → any → `fallbackId`.
 * Used for every catalog display field so a missing translation never blanks the UI.
 */
export function resolveLocalized(text: LocalizedText | undefined, locale: string, fallbackId: string): string {
	if (!text) return fallbackId;
	return text[locale] ?? text[FALLBACK_LOCALE] ?? Object.values(text)[0] ?? fallbackId;
}

export function listPlaybooks(provider: string = DEFAULT_PLAYBOOK_PROVIDER): PlaybookTemplate[] {
	return getPlaybookBundle(provider).playbookTemplates;
}

export function getPlaybook(id: string, provider: string = DEFAULT_PLAYBOOK_PROVIDER): PlaybookTemplate | undefined {
	return listPlaybooks(provider).find((template) => template.id === id);
}

/**
 * The fixed base/fallback playbook. Resolved by `BASE_PLAYBOOK_ID` (single-point switch in
 * metadata.ts), falling back to the first registered template only if the configured base is
 * somehow missing from the bundle.
 */
export function getDefaultPlaybook(provider: string = DEFAULT_PLAYBOOK_PROVIDER): PlaybookTemplate | undefined {
	const bundle = getPlaybookBundle(provider);
	return getPlaybook(BASE_PLAYBOOK_ID, provider) ?? bundle.playbookTemplates[0];
}

/** Resolve a playbook by id, falling back to the base playbook when id is missing/unknown. */
export function resolvePlaybookOrFallback(
	id: string | undefined,
	provider: string = DEFAULT_PLAYBOOK_PROVIDER,
): PlaybookTemplate | undefined {
	if (id) {
		const found = getPlaybook(id, provider);
		if (found) return found;
	}
	return getDefaultPlaybook(provider);
}

/** The active-locale display name for a playbook template (chain: locale → en → any → id). */
export function getPlaybookDisplayName(
	id: string,
	locale: string = DEFAULT_LOCALE,
	provider: string = DEFAULT_PLAYBOOK_PROVIDER,
): string {
	const template = getPlaybook(id, provider);
	return resolveLocalized(template?.displayName, locale, id);
}

export function getEnvironmentProfile(provider: string = DEFAULT_PLAYBOOK_PROVIDER): EnvironmentProfile {
	return getInfrastructure(provider).environment;
}

export function getVaultProfile(provider: string = DEFAULT_PLAYBOOK_PROVIDER): VaultProfile | undefined {
	return getInfrastructure(provider).vault;
}

export function resolveSeedPlaybook(id: string, provider: string = DEFAULT_PLAYBOOK_PROVIDER): ResolvedPlaybook {
	return resolvePlaybook(getPlaybookBundle(provider), id);
}

export function getSeedPlaybookAgentName(id: string, provider: string = DEFAULT_PLAYBOOK_PROVIDER): string {
	return getPlaybookAgentName(getPlaybookBundle(provider), id);
}

export function resolveSeedPlaybookSkills(id: string, provider: string = DEFAULT_PLAYBOOK_PROVIDER) {
	return resolvePlaybookSkills(getPlaybookBundle(provider), id);
}

export function resolveSeedPlaybookMcpServers(id: string, provider: string = DEFAULT_PLAYBOOK_PROVIDER) {
	return resolvePlaybookMcpServers(getPlaybookBundle(provider), id);
}

/** Presentation cards derived purely from synced templates + the active locale. */
export function listPlaybookCards(
	locale: string = DEFAULT_LOCALE,
	provider: string = DEFAULT_PLAYBOOK_PROVIDER,
): PlaybookCard[] {
	return listPlaybooks(provider).map((template) => ({
		id: template.id,
		title: resolveLocalized(template.displayName, locale, template.id),
		prompt: resolveLocalized(template.samplePrompt, locale, ""),
		imageUrl: template.imageUrl,
		playbookTemplateId: template.id,
	}));
}
