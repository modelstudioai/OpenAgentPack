import { UserError } from "../errors.ts";
import type { EventListOptions, EventStreamOptions, SessionEventFormat } from "../types/session-event.ts";

export function sessionEventFormat(options: EventStreamOptions | EventListOptions = {}): SessionEventFormat {
	if (options.event_format !== undefined && options.event_format !== "legacy" && options.event_format !== "snapshot") {
		throw new UserError("Unsupported session event format.");
	}
	const deltas = "event_deltas" in options ? options.event_deltas : undefined;
	if (
		deltas !== undefined &&
		(!Array.isArray(deltas) || deltas.some((type) => type !== "message" && type !== "reasoning"))
	) {
		throw new UserError("event_deltas accepts only message and reasoning.");
	}
	if (deltas?.length && options.event_format === "legacy") {
		throw new UserError("event_deltas requires snapshot event format.");
	}
	return options.event_format ?? (deltas?.length ? "snapshot" : "legacy");
}

export function assertEventOptions(provider: string, options: EventStreamOptions | EventListOptions = {}): void {
	const format = sessionEventFormat(options);
	if (
		provider !== "bailian" &&
		(format === "snapshot" || ("event_deltas" in options && options.event_deltas !== undefined))
	) {
		throw new UserError("Structured snapshots and event_deltas are supported only by Bailian.");
	}
	if ("reconnect" in options && options.reconnect && format !== "snapshot") {
		throw new UserError("Automatic reconnection requires Bailian snapshot event format.");
	}
	for (const key of ["connectTimeoutMs", "idleTimeoutMs"] as const) {
		if (key in options) {
			const value = (options as EventStreamOptions)[key];
			if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
				throw new UserError(`${key} must be a positive finite number.`);
			}
		}
	}
}

export function assertStreamOptions(provider: string, options: EventStreamOptions = {}): void {
	assertEventOptions(provider, options);
	if (
		provider !== "bailian" &&
		[options.signal, options.onReady, options.reconnect, options.connectTimeoutMs, options.idleTimeoutMs].some(
			(value) => value !== undefined,
		)
	) {
		throw new UserError("These stream lifecycle options are supported only by Bailian.");
	}
}
