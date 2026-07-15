// Pure helpers shared by provider mappers (both directions: agents.yaml decl <-> remote).
// No IO — safe to import from mapper.ts.

/**
 * Stamp `agents.project` / `agents.resource` onto a resource's metadata on the create path.
 * User-supplied metadata wins on key collision. Identical across all providers.
 */
export function injectMetadata(
	userMetadata: Record<string, string> | undefined,
	projectName: string,
	resourceName: string,
): Record<string, string> {
	const injected: Record<string, string> = {
		"agents.project": projectName,
		"agents.resource": resourceName,
	};
	return { ...injected, ...userMetadata };
}

/** Lowercase slug suitable for a yaml key. Falls back to `fallback` when empty. */
export function slug(value: string | undefined, fallback: string): string {
	const out = (value ?? "")
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return out || fallback;
}

/**
 * Resolve the yaml resource name (map key). Prefers the `agents.resource` metadata
 * that agents injects on create, otherwise derives a slug from a human label.
 */
export function resourceNameFromMetadata(metadata: unknown, fallbackLabel: string, fallback: string): string {
	if (metadata && typeof metadata === "object") {
		const tagged = (metadata as Record<string, unknown>)["agents.resource"];
		if (typeof tagged === "string" && tagged.trim()) return tagged.trim();
	}
	return slug(fallbackLabel, fallback);
}

/**
 * Environment-variable placeholder for a secret that the remote API never
 * returns (e.g. credential token/secret). Rendered as a literal `${...}` so the
 * synced yaml stays valid and the user fills it via .env before apply.
 */
export function secretPlaceholder(vaultName: string, credName: string): string {
	const norm = (s: string) =>
		s
			.replace(/[^A-Za-z0-9]+/g, "_")
			.replace(/^_+|_+$/g, "")
			.toUpperCase();
	return `\${VAULT_${norm(vaultName)}_${norm(credName)}}`;
}
