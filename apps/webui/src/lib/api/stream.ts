import type { SessionEvent } from "@openagentpack/sdk";

export type SessionStreamStatus = "connecting" | "streaming" | "done" | "error";

export interface SessionStreamCallbacks {
	onEvent: (event: SessionEvent) => void;
	onDone: (error: string | null) => void;
	onConnectionError?: () => void;
}

export function connectSessionStream(
	sessionId: string,
	afterIndex: number,
	callbacks: SessionStreamCallbacks,
): () => void {
	const url = `/api/sessions/${sessionId}/stream?after=${afterIndex}`;
	let closed = false;
	const controller = new AbortController();

	void (async () => {
		try {
			const response = await fetch(url, {
				signal: controller.signal,
				cache: "no-store",
			});

			if (response.status === 204) {
				if (!closed) callbacks.onDone(null);
				return;
			}

			if (!response.ok || !response.body) {
				if (!closed) callbacks.onConnectionError?.();
				return;
			}

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			let buffer = "";

			while (!closed) {
				// Sequential by nature: each read returns the next stream chunk and appends to `buffer`
				// (a loop-carried dependency). Reads cannot run in parallel.
				// oxlint-disable-next-line react-doctor/async-await-in-loop
				const { done, value } = await reader.read();
				if (done) break;

				buffer += decoder.decode(value, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";

				let currentEventType = "";
				let currentData = "";

				for (const line of lines) {
					if (line.startsWith("event: ")) {
						currentEventType = line.slice(7);
					} else if (line.startsWith("data: ")) {
						currentData = line.slice(6);
					} else if (line === "") {
						if (currentEventType && currentData) {
							handleSSEFrame(currentEventType, currentData, callbacks, () => closed);
						}
						currentEventType = "";
						currentData = "";
					}
				}
			}
		} catch (err) {
			if (closed) return;
			if (err instanceof DOMException && err.name === "AbortError") return;
			callbacks.onConnectionError?.();
		}
	})();

	return () => {
		closed = true;
		controller.abort();
	};
}

function handleSSEFrame(
	eventType: string,
	data: string,
	callbacks: SessionStreamCallbacks,
	isClosed: () => boolean,
): void {
	if (isClosed()) return;

	switch (eventType) {
		case "event": {
			try {
				const event = JSON.parse(data) as SessionEvent;
				callbacks.onEvent(event);
			} catch {
				// Ignore malformed event.
			}
			break;
		}
		case "done": {
			try {
				const payload = JSON.parse(data) as { error: string | null };
				callbacks.onDone(payload.error);
			} catch {
				callbacks.onDone(null);
			}
			break;
		}
		case "ping":
			break;
	}
}
