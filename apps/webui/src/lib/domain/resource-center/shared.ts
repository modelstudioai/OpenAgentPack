export function toEpoch(iso?: string): number {
	if (!iso) return 0;
	const t = Date.parse(iso);
	return Number.isNaN(t) ? 0 : t;
}
