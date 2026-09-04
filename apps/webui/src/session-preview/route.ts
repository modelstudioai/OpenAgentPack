export function sessionPreviewIdFromPath(pathname: string): string | null {
	const match = /^\/sessions\/(.*)\/preview\/?$/.exec(pathname);
	if (!match) return null;
	try {
		const sessionId = decodeURIComponent(match[1] ?? "").trim();
		return sessionId && !sessionId.includes("/") ? sessionId : "";
	} catch {
		return "";
	}
}

export function agentSessionPreviewIdFromPath(pathname: string): string | null {
	const match = /^\/agents\/(.*)\/preview\/?$/.exec(pathname);
	if (!match) return null;
	try {
		const agentId = decodeURIComponent(match[1] ?? "").trim();
		return agentId && !agentId.includes("/") ? agentId : "";
	} catch {
		return "";
	}
}
