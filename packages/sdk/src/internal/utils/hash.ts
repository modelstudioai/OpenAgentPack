import { createHash } from "node:crypto";

export function sha256(data: string | Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

export function contentHash(obj: unknown): string {
	const normalized = JSON.stringify(sortDeep(obj));
	return sha256(normalized);
}

function sortDeep(obj: unknown): unknown {
	if (obj === null || obj === undefined) return obj;
	if (Array.isArray(obj)) return obj.map(sortDeep);
	if (typeof obj === "object") {
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
			sorted[key] = sortDeep((obj as Record<string, unknown>)[key]);
		}
		return sorted;
	}
	return obj;
}
