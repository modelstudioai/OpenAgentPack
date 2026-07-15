declare global {
	interface Window {
		__AGENTS_PLAYGROUND__?: boolean;
	}
}

/** True when the SPA is served by `agents playground` (local OpenAgentPack Playground server). */
export function isPlaygroundMode(): boolean {
	if (typeof window === "undefined") return false;
	if (window.__AGENTS_PLAYGROUND__ === true) return true;
	return document.querySelector('meta[name="agents-runtime"][content="playground"]') !== null;
}
