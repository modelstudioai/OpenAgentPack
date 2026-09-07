import type { SessionEvent } from "@openagentpack/sdk";
import { useCallback, useEffect, useRef, useState } from "react";
import { buildRegenerateDownloadLinkMessage } from "@/lib/artifact-file-name";
import {
	cancelSession,
	getSession,
	getSessionArtifactDownloadUrl,
	type SessionDetail,
	sendSessionMessage,
	sessionEventSource,
} from "@/lib/project-api";
import { classifySessionPreviewLoadError, type SessionPreviewUnavailableReason } from "./errors";
import { mergeSessionEvents } from "./events";

export type SessionPreviewStreamState = "idle" | "connecting" | "streaming" | "reconnecting" | "done";

export interface SessionPreviewController {
	detail?: SessionDetail;
	events: SessionEvent[];
	loading: boolean;
	busy: boolean;
	streamState: SessionPreviewStreamState;
	unavailableReason?: SessionPreviewUnavailableReason;
	error?: string;
	streamNotice?: string;
	send(message: string): Promise<void>;
	terminate(): Promise<void>;
	regenerate(fileName: string): Promise<void>;
	resolveDeliveredFile(fileId: string): Promise<string>;
}

export function useProjectSessionPreview(sessionId: string): SessionPreviewController {
	const [detail, setDetail] = useState<SessionDetail>();
	const [events, setEvents] = useState<SessionEvent[]>([]);
	const [loading, setLoading] = useState(true);
	const [busy, setBusy] = useState(false);
	const [streamState, setStreamState] = useState<SessionPreviewStreamState>("idle");
	const [unavailableReason, setUnavailableReason] = useState<SessionPreviewUnavailableReason>();
	const [error, setError] = useState<string>();
	const [streamNotice, setStreamNotice] = useState<string>();
	const sourceRef = useRef<EventSource | null>(null);
	const generationRef = useRef(0);
	const eventsRef = useRef<SessionEvent[]>([]);

	const replaceEvents = useCallback((next: SessionEvent[]) => {
		eventsRef.current = next;
		setEvents(next);
	}, []);

	const appendEvent = useCallback((event: SessionEvent) => {
		const next = mergeSessionEvents(eventsRef.current, [event]);
		eventsRef.current = next;
		setEvents(next);
	}, []);

	const connect = useCallback(
		(seed: SessionEvent[]) => {
			sourceRef.current?.close();
			const generation = ++generationRef.current;
			let finished = false;
			replaceEvents(seed);
			setBusy(true);
			setStreamState("connecting");
			setStreamNotice(undefined);
			const source = sessionEventSource(sessionId, seed.length - 1);
			sourceRef.current = source;

			source.onopen = () => {
				if (generation !== generationRef.current) return;
				setStreamState("streaming");
				setStreamNotice(undefined);
			};
			source.addEventListener("event", (message) => {
				if (generation !== generationRef.current) return;
				const event = safeJson((message as MessageEvent).data);
				if (isSessionEvent(event)) appendEvent(event);
				else setStreamNotice("A malformed Session event was skipped while the stream remained connected.");
			});
			source.addEventListener("done", (message) => {
				if (generation !== generationRef.current) return;
				finished = true;
				source.close();
				setBusy(false);
				setStreamState("done");
				const payload = safeJson((message as MessageEvent).data) as { error?: string | null } | undefined;
				if (payload?.error) setError(payload.error);
				void getSession(sessionId)
					.then((next) => {
						if (generation !== generationRef.current) return;
						setDetail(next);
						replaceEvents(mergeSessionEvents(eventsRef.current, next.events));
					})
					.catch(() => {
						// Keep the completed event buffer visible when the Provider no longer returns detail.
					});
			});
			source.onerror = () => {
				if (generation !== generationRef.current || finished) return;
				if (source.readyState === EventSource.CLOSED) {
					setBusy(false);
					setStreamState("done");
					setStreamNotice(undefined);
					setError(
						"The Session event stream could not be recovered after the Server restart. Reload the page to retry from Provider history.",
					);
					return;
				}
				setStreamState("reconnecting");
				setStreamNotice("Session event stream disconnected; reconnecting from the last received event…");
			};
		},
		[appendEvent, replaceEvents, sessionId],
	);

	useEffect(() => {
		if (!sessionId) {
			setLoading(false);
			setError("The Preview URL does not contain a valid Session ID.");
			return;
		}
		let cancelled = false;
		setLoading(true);
		setError(undefined);
		setUnavailableReason(undefined);
		void getSession(sessionId)
			.then((next) => {
				if (cancelled) return;
				setDetail(next);
				replaceEvents(next.events);
				setLoading(false);
				connect(next.events);
			})
			.catch((loadError) => {
				if (cancelled) return;
				const classified = classifySessionPreviewLoadError(loadError);
				setLoading(false);
				setUnavailableReason(classified.reason);
				setError(classified.message);
			});
		return () => {
			cancelled = true;
			generationRef.current += 1;
			sourceRef.current?.close();
		};
	}, [connect, replaceEvents, sessionId]);

	const send = useCallback(
		async (message: string) => {
			const value = message.trim();
			if (!value || busy) return;
			setError(undefined);
			setBusy(true);
			sourceRef.current?.close();
			try {
				const next = await sendSessionMessage(sessionId, value);
				setDetail(next);
				connect(mergeSessionEvents(eventsRef.current, next.events));
			} catch (sendError) {
				setBusy(false);
				setError(errorMessage(sendError));
				throw sendError;
			}
		},
		[busy, connect, sessionId],
	);

	const terminate = useCallback(async () => {
		setError(undefined);
		try {
			await cancelSession(sessionId);
			generationRef.current += 1;
			sourceRef.current?.close();
			setBusy(false);
			setStreamState("done");
			setStreamNotice(undefined);
			setDetail((current) =>
				current ? { ...current, session: { ...current.session, status: "terminated" } } : current,
			);
		} catch (terminateError) {
			setError(errorMessage(terminateError));
			throw terminateError;
		}
	}, [sessionId]);

	return {
		detail,
		events,
		loading,
		busy,
		streamState,
		unavailableReason,
		error,
		streamNotice,
		send,
		terminate,
		regenerate: (fileName) => send(buildRegenerateDownloadLinkMessage(fileName)),
		resolveDeliveredFile: (fileId) => getSessionArtifactDownloadUrl(sessionId, fileId),
	};
}

function safeJson(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return undefined;
	}
}

function isSessionEvent(value: unknown): value is SessionEvent {
	return Boolean(value && typeof value === "object" && "type" in value && typeof value.type === "string");
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
