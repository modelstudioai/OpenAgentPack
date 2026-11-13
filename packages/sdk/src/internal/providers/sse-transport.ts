import { resolveFetch } from "../transport.ts";
import { SseParser } from "./sse-parser.ts";

export interface SseRequestOptions {
	headers?: Record<string, string>;
	signal?: AbortSignal;
	/** Snapshot streams reject malformed frames and unexpected EOF. */
	strict?: boolean;
	onReady?: () => void;
	connectTimeoutMs?: number;
	idleTimeoutMs?: number;
}

export type SseTransportErrorCode =
	| "http"
	| "network"
	| "unexpected-eof"
	| "connect-timeout"
	| "idle-timeout"
	| "protocol";

const ERROR_MESSAGES: Record<SseTransportErrorCode, string> = {
	http: "SSE request failed",
	network: "SSE network connection failed",
	"unexpected-eof": "SSE connection closed before the subscription ended",
	"connect-timeout": "SSE connection timed out",
	"idle-timeout": "SSE connection received no network activity before the timeout",
	protocol: "SSE response contains an invalid event",
};

/** No URL, credentials, provider body or unsanitized cause is attached. */
export class SseTransportError extends Error {
	readonly retryable: boolean;

	constructor(
		readonly code: SseTransportErrorCode,
		readonly statusCode?: number,
	) {
		super(`${ERROR_MESSAGES[code]}${statusCode === undefined ? "" : ` (HTTP ${statusCode})`}`);
		this.name = "SseTransportError";
		this.retryable =
			code === "http"
				? statusCode === 429 || (statusCode !== undefined && statusCode >= 500 && statusCode <= 599)
				: code !== "protocol";
	}
}

function abortError(): Error {
	return new DOMException("SSE subscription was cancelled", "AbortError");
}

/** Abort races also cover custom fetch implementations that ignore AbortSignal. */
class StreamCancellation {
	readonly controller = new AbortController();
	private failure: Error | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private readonly onAbort = () => this.abort(abortError());

	constructor(private readonly signal?: AbortSignal) {
		if (signal?.aborted) this.onAbort();
		else signal?.addEventListener("abort", this.onAbort, { once: true });
	}

	abort(error: Error): void {
		if (this.failure) return;
		this.failure = error;
		this.controller.abort();
	}

	throwIfAborted(): void {
		if (this.failure) throw this.failure;
	}

	startTimeout(ms: number | undefined, code: "connect-timeout" | "idle-timeout"): void {
		this.clearTimeout();
		if (ms !== undefined) this.timer = setTimeout(() => this.abort(new SseTransportError(code)), ms);
	}

	clearTimeout(): void {
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
	}

	wait<T>(pending: Promise<T>): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const signal = this.controller.signal;
			const onAbort = () => reject(this.failure ?? abortError());
			if (signal.aborted) {
				// Still observe rejection of a pending read/fetch after cancellation.
				void pending.catch(() => {});
				onAbort();
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
			pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
		});
	}

	dispose(): void {
		this.clearTimeout();
		this.signal?.removeEventListener("abort", this.onAbort);
		this.controller.abort();
	}
}

function timeout(value: number | undefined, fallback: number | undefined): number | undefined {
	if (value === undefined) return fallback;
	if (!Number.isFinite(value) || value <= 0) throw new RangeError("SSE timeout must be a positive finite number");
	return value;
}

export async function* streamSse(
	url: string,
	headers: Record<string, string>,
	options: SseRequestOptions = {},
	checkLegacyResponse: (response: Response) => Promise<void>,
): AsyncGenerator<Record<string, unknown>> {
	const strict = options.strict === true;
	// The legacy path has no new timeout unless the caller explicitly opts in.
	const connectTimeout = timeout(options.connectTimeoutMs, strict ? 30_000 : undefined);
	const idleTimeout = timeout(options.idleTimeoutMs, strict ? 180_000 : undefined);
	const cancellation = new StreamCancellation(options.signal);
	let reader: { cancel(): Promise<void>; releaseLock(): void } | undefined;
	try {
		cancellation.throwIfAborted();
		cancellation.startTimeout(connectTimeout, "connect-timeout");
		let response: Response;
		try {
			response = await cancellation.wait(
				resolveFetch()(url, {
					method: "GET",
					headers: { ...headers, Accept: "text/event-stream", ...options.headers },
					signal: cancellation.controller.signal,
				}),
			);
		} catch (error) {
			cancellation.throwIfAborted();
			if (strict) throw new SseTransportError("network");
			throw error;
		}
		if (strict && !response.ok) throw new SseTransportError("http", response.status);
		if (!strict) await cancellation.wait(checkLegacyResponse(response));
		if (!response.body) throw new SseTransportError("protocol");
		const activeReader = response.body.getReader();
		reader = activeReader;
		cancellation.clearTimeout();
		cancellation.throwIfAborted();
		options.onReady?.();
		const parser = new SseParser();
		const decoder = new TextDecoder("utf-8", { fatal: strict });
		for (;;) {
			cancellation.throwIfAborted();
			cancellation.startTimeout(idleTimeout, "idle-timeout");
			let chunk: Awaited<ReturnType<typeof activeReader.read>>;
			try {
				chunk = await cancellation.wait(activeReader.read());
			} catch (error) {
				cancellation.throwIfAborted();
				if (strict) throw new SseTransportError("network");
				throw error;
			} finally {
				cancellation.clearTimeout();
			}
			if (chunk.done) {
				if (strict) throw new SseTransportError("unexpected-eof");
				return;
			}
			let text: string;
			try {
				text = decoder.decode(chunk.value, { stream: true });
			} catch {
				throw new SseTransportError("protocol");
			}
			for (const frame of parser.push(text)) {
				if (frame.event?.trim() === "heartbeat") continue;
				let parsed: Record<string, unknown>;
				try {
					parsed = JSON.parse(frame.data) as Record<string, unknown>;
					if (strict && (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))) {
						throw new Error("Invalid event object");
					}
					if (!strict && frame.id !== undefined && parsed.id === undefined) parsed.id = frame.id;
				} catch {
					if (strict) throw new SseTransportError("protocol");
					continue;
				}
				cancellation.throwIfAborted();
				yield parsed;
			}
		}
	} finally {
		cancellation.dispose();
		if (reader) {
			try {
				await reader.cancel();
			} catch {
				// A fetch abort may already have errored the underlying stream.
			}
			reader.releaseLock();
		}
	}
}
