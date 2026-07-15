// Browser twin of the SDK's resolveStampedResource. Identical algorithm, separate copy: webui
// browser code cannot runtime-import @openagentpack/sdk (no-webui-sdk-runtime-import), so the
// Identity-Stamp recency resolution lives once per runtime — server (SDK) and browser (here).

export interface ResolveStampedResult<T> {
	winner: T | undefined;
	duplicates: T[];
}

function epochOf(value: string | number | null | undefined): number {
	if (value == null) return 0;
	if (typeof value === "number") return value;
	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Pick the canonical stamped resource. `matches` is the caller's stamp predicate; `updatedAt`
 * reads the recency field (raw ISO string or epoch). On a tie the stable sort keeps the item
 * nearest the front of `items` — deterministic.
 */
export function resolveStampedResource<T>(
	items: T[],
	opts: {
		matches: (item: T) => boolean;
		updatedAt: (item: T) => string | number | null | undefined;
	},
): ResolveStampedResult<T> {
	const matched = items.filter(opts.matches);
	if (matched.length <= 1) return { winner: matched[0], duplicates: [] };
	const sorted = [...matched].sort((a, b) => epochOf(opts.updatedAt(b)) - epochOf(opts.updatedAt(a)));
	const [winner, ...duplicates] = sorted;
	return { winner, duplicates };
}
