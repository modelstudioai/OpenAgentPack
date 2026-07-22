import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const AGENTS_CONFIG_PROVIDERS = ["bailian", "qoder", "ark", "claude"] as const;
export type ProviderConfigProvider = (typeof AGENTS_CONFIG_PROVIDERS)[number];

export const AGENTS_PROVIDER_FIELDS: Record<
	ProviderConfigProvider,
	readonly { key: string; label: string; secret: boolean }[]
> = {
	bailian: [
		{ key: "DASHSCOPE_API_KEY", label: "DASHSCOPE API Key", secret: true },
		{ key: "BAILIAN_WORKSPACE_ID", label: "Workspace ID", secret: false },
	],
	qoder: [{ key: "QODER_PAT", label: "QODER PAT", secret: true }],
	ark: [{ key: "ARK_API_KEY", label: "ARK API Key", secret: true }],
	claude: [{ key: "ANTHROPIC_API_KEY", label: "Anthropic API Key", secret: true }],
};

export type ProviderConfig = {
	AGENTS_PROVIDER: ProviderConfigProvider;
	[key: string]: string;
};

const ALL_FIELD_KEYS = new Set(
	Object.values(AGENTS_PROVIDER_FIELDS).flatMap((fields) => fields.map((field) => field.key)),
);

export function providerConfigPath(): string {
	return process.env.AGENTS_CONFIG_PATH?.trim() || join(homedir(), ".agents", "config.json");
}

/** Active provider after bootstrap — defaults to bailian when unset. */
export function resolveActiveProvider(): ProviderConfigProvider {
	const raw = process.env.AGENTS_PROVIDER?.trim();
	if (raw && isProvider(raw)) return raw;
	return "bailian";
}

/** Whether the current process env has all required fields for the active provider. */
export function areRuntimeCredentialsReady(): boolean {
	const provider = resolveActiveProvider();
	return AGENTS_PROVIDER_FIELDS[provider].every((field) => {
		if (process.env[field.key]?.trim()) return true;
		// bailian derives its endpoint from either workspace_id or base_url, so a
		// configured BAILIAN_BASE_URL satisfies the workspace_id slot (mirrors the
		// provider config schema's "at least one" rule).
		if (field.key === "BAILIAN_WORKSPACE_ID") return Boolean(process.env.BAILIAN_BASE_URL?.trim());
		return false;
	});
}

function isProvider(value: string): value is ProviderConfigProvider {
	return (AGENTS_CONFIG_PROVIDERS as readonly string[]).includes(value);
}

function applyDotEnvContent(content: string): void {
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const raw = trimmed.startsWith("export ") ? trimmed.slice("export ".length) : trimmed;
		const eq = raw.indexOf("=");
		if (eq <= 0) continue;
		const key = raw.slice(0, eq).trim();
		let value = raw.slice(eq + 1).trim();
		if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
			value = value.slice(1, -1);
		}
		if (!process.env[key]?.trim()) {
			process.env[key] = value;
		}
	}
}

function loadDotEnvFile(envPath: string): void {
	try {
		if (typeof process.loadEnvFile === "function") {
			process.loadEnvFile(envPath);
			return;
		}
	} catch {
		// fall through to manual parse (Bun / older Node)
	}
	applyDotEnvContent(readFileSync(envPath, "utf8"));
}

/** Load the nearest `.env` walking up from `startDir` (at most 10 levels). */
export function loadDotEnv(startDir: string = process.cwd()): string | undefined {
	let dir = startDir;
	for (let depth = 0; depth < 10; depth++) {
		const envPath = join(dir, ".env");
		try {
			loadDotEnvFile(envPath);
			return envPath;
		} catch {
			// missing or unreadable — try parent
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return undefined;
}

/** Apply config.json provider fields to `process.env`. With `force: false`, only unset vars are filled. */
export function applyProviderConfigToEnv(config: ProviderConfig, { force = false }: { force?: boolean } = {}): void {
	if (force || !process.env.AGENTS_PROVIDER?.trim()) {
		process.env.AGENTS_PROVIDER = config.AGENTS_PROVIDER;
	}
	for (const key of ALL_FIELD_KEYS) {
		const value = config[key];
		if (!value) continue;
		if (force || !process.env[key]?.trim()) {
			process.env[key] = value;
		}
	}
}

function parseProviderConfigFile(raw: string): ProviderConfig {
	const parsed = JSON.parse(raw) as Record<string, unknown>;
	const providerRaw = typeof parsed.AGENTS_PROVIDER === "string" ? parsed.AGENTS_PROVIDER : undefined;
	if (typeof providerRaw !== "string" || !isProvider(providerRaw.trim())) {
		throw new Error(`AGENTS_PROVIDER must be one of: ${AGENTS_CONFIG_PROVIDERS.join(", ")}`);
	}
	const provider = providerRaw.trim() as ProviderConfigProvider;
	const config: ProviderConfig = { AGENTS_PROVIDER: provider };
	for (const field of AGENTS_PROVIDER_FIELDS[provider]) {
		const raw = parsed[field.key];
		const value = typeof raw === "string" ? raw.trim() : "";
		if (!value) {
			throw new Error(`Missing required field '${field.key}' for provider '${provider}'`);
		}
		config[field.key] = value;
	}
	return config;
}

/** Load ~/.agents/config.json into `process.env`. Bootstrap passes `{ force: true }` so config.json wins. */
export function loadProviderConfigIntoEnvSync(options: { force?: boolean } = {}): void {
	const path = providerConfigPath();
	try {
		const raw = readFileSync(path, "utf8");
		applyProviderConfigToEnv(parseProviderConfigFile(raw), options);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		console.warn(`[agents] Failed to load ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Async variant for servers that prefer non-blocking I/O at startup. */
export async function loadProviderConfigIntoEnv(options: { force?: boolean } = {}): Promise<void> {
	const path = providerConfigPath();
	try {
		const raw = await readFile(path, "utf8");
		applyProviderConfigToEnv(parseProviderConfigFile(raw), options);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		console.warn(`[agents] Failed to load ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/**
 * Runtime credential bootstrap:
 * 1. `.env` (and pre-set shell env) — lowest priority for provider fields
 * 2. `~/.agents/config.json` — highest priority; overrides conflicting provider fields
 */
export function bootstrapRuntimeCredentialsSync(startDir: string = process.cwd()): void {
	loadDotEnv(startDir);
	loadProviderConfigIntoEnvSync({ force: true });
}

export async function bootstrapRuntimeCredentials(startDir: string = process.cwd()): Promise<void> {
	loadDotEnv(startDir);
	await loadProviderConfigIntoEnv({ force: true });
}
