// Host-injectable transport seam. A host embedding the SDK (a CLI, a server)
// can install a fetch-compatible implementation — e.g. to add tracking headers
// or request logging — without monkey-patching globalThis.fetch. Response
// semantics (ApiError classification, SSE parsing, pagination) stay in the
// provider clients regardless of the installed implementation.

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

let defaultFetch: FetchLike | undefined;

/** Install the fetch implementation used by all provider clients; pass undefined to reset. */
export function setDefaultFetch(fetchImpl: FetchLike | undefined): void {
	defaultFetch = fetchImpl;
}

/**
 * Resolve the active fetch implementation. Falls back to the *current*
 * globalThis.fetch (resolved per call, so test-time fetch mocks keep working).
 */
export function resolveFetch(): FetchLike {
	return defaultFetch ?? ((input, init) => fetch(input, init));
}
