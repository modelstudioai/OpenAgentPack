export { sanitizeSessionEvent, sanitizeSessionEvents } from "@openagentpack/sdk/session-events";

export function shouldIncludeDebugRaw(request: Request): boolean {
	const url = new URL(request.url);
	return process.env.NODE_ENV !== "production" && url.searchParams.get("debug") === "1";
}
