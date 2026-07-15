import { expect, test } from "bun:test";
import type { SessionEvent } from "@openagentpack/sdk";
import { getDisplayEvents } from "../src/lib/view/run-timeline";
import type { ClientTask } from "../src/lib/view/task-view";

function task(events: SessionEvent[], overrides: Partial<ClientTask> = {}): ClientTask {
	return {
		id: "sesn_1",
		title: "T",
		prompt: "summarize it",
		status: "done",
		createdAt: 1,
		updatedAt: 1,
		type: "text",
		events,
		...overrides,
	};
}

function msg(role: "user" | "assistant", text: string): SessionEvent {
	return {
		type: "message",
		role,
		content: [{ type: "text", text }],
		metadata: { display_bucket: "message" },
	} as SessionEvent;
}

// The sent message may carry an injected file-mount hint, so the provider-echoed leading user
// event no longer matches the clean prompt verbatim. It must still be filtered (it duplicates the
// prompt bubble rendered separately) — by position+role, not exact text.
test("leading user echo is filtered even when it carries an injected file hint", () => {
	const echo = msg("user", "The user uploaded files...\n\nsummarize it");
	const reply = msg("assistant", "done");
	const display = getDisplayEvents(task([echo, reply]));
	expect(display).toEqual([reply]);
});

test("leading user echo is filtered when it matches the prompt exactly (no files)", () => {
	const echo = msg("user", "summarize it");
	const reply = msg("assistant", "done");
	expect(getDisplayEvents(task([echo, reply]))).toEqual([reply]);
});

test("follow-up user messages are preserved", () => {
	const echo = msg("user", "summarize it");
	const reply = msg("assistant", "done");
	const followUp = msg("user", "now translate it");
	expect(getDisplayEvents(task([echo, reply, followUp]))).toEqual([reply, followUp]);
});

test("a leading assistant message is not filtered", () => {
	const reply = msg("assistant", "hi");
	expect(getDisplayEvents(task([reply]))).toEqual([reply]);
});
