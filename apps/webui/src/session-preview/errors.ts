export type SessionPreviewUnavailableReason = "not_found" | "unrecoverable" | "server_unavailable" | "unknown";

export interface SessionPreviewLoadError {
	reason: SessionPreviewUnavailableReason;
	message: string;
}

export function classifySessionPreviewLoadError(error: unknown): SessionPreviewLoadError {
	const message = error instanceof Error ? error.message : String(error);
	const status = readStatus(error);
	if (status === 404) return { reason: "not_found", message };
	if (/session not found|no longer declared|no longer matches|could not be recovered/i.test(message)) {
		return { reason: "unrecoverable", message };
	}
	if (/failed to fetch|networkerror|load failed|econnrefused/i.test(message)) {
		return { reason: "server_unavailable", message };
	}
	return { reason: "unknown", message };
}

function readStatus(error: unknown): number | undefined {
	if (!error || typeof error !== "object" || !("status" in error)) return undefined;
	return typeof error.status === "number" ? error.status : undefined;
}
