export const PLAYBOOK_APP_METADATA_KEY = "app_id";
export const DEFAULT_PLAYBOOK_APP_ID = "agents-webui";
export const DEFAULT_PLAYBOOK_PROVIDER = "bailian";
export const PLAYBOOK_AGENT_NAME_PREFIX = "Agents/";
export const PLAYBOOK_METADATA_KEY = "playbook_id";

/**
 * Per-provider runtime defaults for catalog playbooks. The playbook templates author a
 * bailian-native model (qwen); when a deployment targets another provider, the catalog
 * substitutes that provider's default model. Each provider runs on its OWN infrastructure
 * (see infrastructure.ts): bailian installs `bailian-cli` + a `DASHSCOPE_API_KEY` vault;
 * other providers ship a generic cloud sandbox + a vault holding that provider's own
 * credential, and their playbooks carry no bailian-cli dependency. Model ids should be
 * validated against `listModels`.
 */
export const PROVIDER_DEFAULTS: Record<string, { model: string }> = {
	bailian: { model: "qwen3.7-max" },
	claude: { model: "claude-sonnet-4-6" },
	qoder: { model: "ultimate" },
	ark: { model: "deepseek-v4-pro-260425" },
};

/**
 * The fixed base/fallback playbook id. Used wherever an unknown or missing playbook
 * reference needs to resolve to something runnable (e.g. stale showcase cards, lookups
 * past the catalog). Single-point switch: change this constant to swap the base.
 * Backed by the `Agents/base` agent fixture (a domain-neutral generalist). Future
 * enhancement: replace this with an `isDefault: true` flag on PlaybookTemplate so the
 * choice lives in the catalog data, not in code.
 */
export const BASE_PLAYBOOK_ID = "base";

// Flat, snake_case, locale-suffixed display metadata keys hand-filled in the console metabox.
// The sync reads these off the source Agent; resolution/catalog never invents defaults for them.
export const DISPLAY_NAME_METADATA_PREFIX = "display_name_";
export const SAMPLE_PROMPT_METADATA_PREFIX = "sample_prompt_";
export const AVATAR_PATH_METADATA_KEY = "avatar_url";
/** Console metadata key holding the export's stable template id; preferred over the backend agent id. */
export const TEMPLATE_ID_METADATA_KEY = "template_id";

/** Default active locale for catalog display (the app is Chinese-first). */
export const DEFAULT_LOCALE = "zh";
/** Locale used as the first fallback when the active locale is absent. */
export const FALLBACK_LOCALE = "en";
