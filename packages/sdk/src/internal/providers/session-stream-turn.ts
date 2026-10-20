import type { EventStreamOptions } from "../types/session-event.ts";

// A high-level send and its provider subscription share the exact options object.
// Keep the turn boundary internal: no public options, event fields, or wire parameters.
const turnStarts = new WeakMap<EventStreamOptions, Promise<string | undefined>>();

export function bindSessionStreamTurn(options: EventStreamOptions): (eventId: string | undefined) => void {
	let resolve!: (eventId: string | undefined) => void;
	turnStarts.set(
		options,
		new Promise((done) => {
			resolve = done;
		}),
	);
	// If sending fails, the owning iterator aborts the subscription. This promise
	// only resolves, so a failed send cannot leave an unobserved rejection behind.
	return resolve;
}

export function sessionStreamTurn(options: EventStreamOptions): Promise<string | undefined> | undefined {
	return turnStarts.get(options);
}
