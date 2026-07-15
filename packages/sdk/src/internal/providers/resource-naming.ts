/**
 * Provider-specific resource name normalization at the wire boundary.
 *
 * Domain-facing names (config/webui/display) remain unchanged; only the remote API
 * payload name is normalized when a provider enforces stricter constraints.
 */

export type ResourceNameKind = "environment" | "agent" | "vault" | "skill" | "memory_store";

type NameNormalizer = (name: string) => string;

type ResourceNamingProfile = Partial<Record<ResourceNameKind, NameNormalizer>>;

const IDENTITY: NameNormalizer = (name) => name;

const PROFILES: Record<string, ResourceNamingProfile> = {
	ark: {
		environment: normalizeArkEnvironmentName,
	},
};

/**
 * Normalize a logical resource name to the provider wire name.
 * Unknown providers (or kinds without explicit rules) pass through unchanged.
 */
export function normalizeWireResourceName(provider: string, kind: ResourceNameKind, name: string): string {
	const normalizer = PROFILES[provider]?.[kind] ?? IDENTITY;
	return normalizer(name);
}

/**
 * Ark validates environment.name with `^[a-z0-9][a-z0-9-_.]{2,63}$`.
 */
function normalizeArkEnvironmentName(name: string): string {
	const lowered = name.trim().toLowerCase();
	let out = lowered
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[^a-z0-9]+/, "")
		.replace(/-+/g, "-");
	if (!out) out = "env";
	if (out.length < 3) out = `${out}-env`;
	if (out.length > 64) out = out.slice(0, 64);
	if (!/^[a-z0-9]/.test(out)) out = `e${out}`;
	return out;
}

/** Ark Environment Name Max Length (64 characters). */
const ARK_ENV_NAME_MAX_LEN = 64;

/**
 * Ark Environment Wire Name Retry Sequence: First use normalized base name, then append -1, -2, ...
 * (e.g. agents-base → agents-base-1 → agents-base-2).
 */
export function arkEnvironmentWireNameAttempt(baseWireName: string, attempt: number): string {
	if (attempt <= 0) return baseWireName;
	const suffix = `-${attempt}`;
	const prefix = baseWireName.slice(0, Math.max(ARK_ENV_NAME_MAX_LEN - suffix.length, 3));
	return `${prefix}${suffix}`;
}
