export function compactDeep(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(compactDeep).filter((v) => v !== undefined);
	}
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
			const v = compactDeep(raw);
			if (v !== undefined) out[key] = v;
		}
		return out;
	}
	return value;
}

export function stripAgentsMetadata(value: unknown): Record<string, string> | undefined {
	if (!value || typeof value !== "object") return undefined;
	const out: Record<string, string> = {};
	for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
		if (key.startsWith("agents.")) continue;
		if (typeof raw === "string") out[key] = raw;
	}
	return Object.keys(out).length > 0 ? out : undefined;
}
