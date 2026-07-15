/**
 * Shared formatting utilities for the Resource Center.
 * Pure functions — no React, no state, no side-effects.
 */

export function fmtTime(iso?: string): string {
	if (!iso) return "—";
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return iso;
	const p = (n: number) => String(n).padStart(2, "0");
	return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function shortId(id: string): string {
	return id.length > 10 ? `${id.slice(0, 6)}…${id.slice(-5)}` : id;
}

export function formatBytes(bytes?: number): string {
	if (!bytes) return "—";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function compactList(items: string[]): string {
	if (items.length === 0) return "—";
	if (items.length <= 3) return items.join("、");
	return `${items.slice(0, 3).join("、")} 等 ${items.length} 项`;
}
