/**
 * A bound vault is echoed either as a top-level `vault_ids` (top-level create form)
 * or inside `resources` as `{type:"vault", id}` (resources create form). Read
 * whichever is populated so the binding is observable regardless of which create
 * shape a provider uses — kept here so every provider's toSessionInfo agrees.
 */
export function extractVaultIds(res: Record<string, unknown>): string[] {
	const top = res.vault_ids;
	if (Array.isArray(top) && top.length) return top as string[];
	const resources = res.resources;
	if (!Array.isArray(resources)) return [];
	return resources
		.filter((r): r is Record<string, unknown> => !!r && typeof r === "object" && r.type === "vault")
		.map((r) => r.id as string)
		.filter(Boolean);
}
