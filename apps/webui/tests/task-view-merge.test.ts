import { expect, test } from "bun:test";
import type { SessionEvent } from "@openagentpack/sdk";
import { type ClientTask, mergeClientTask, normalizeTaskFromDetail } from "../src/lib/view/task-view";

function task(overrides: Partial<ClientTask> = {}): ClientTask {
	return {
		id: "sesn_1",
		title: "T",
		prompt: "T",
		status: "done",
		createdAt: 1,
		updatedAt: 1,
		type: "text",
		events: [],
		...overrides,
	};
}

const agentMessage: SessionEvent = { type: "message", role: "assistant" } as SessionEvent;

// Regression: the list endpoint returns session summaries with NO events. An idle (→done) session
// must NOT be flipped to "running" on merge — that fabricated "running" drove an endless 2.5s poll
// fan-out (one listSessions per agent, every tick) on the homepage.
test("[regression] list-path merge keeps an idle/done session done (empty events ≠ no output)", () => {
	const incoming = task({ status: "done", events: [] });
	const current = task({ status: "done", events: [] });
	expect(mergeClientTask(incoming, current).status).toBe("done");
});

// The detail path DOES carry the full event set, so empty events there genuinely means "no output
// yet" → idle is a false report → running. That behavior must stay.
test("[regression] detail-path normalize still flips a no-output done session to running", () => {
	expect(normalizeTaskFromDetail(task({ status: "done", events: [] })).status).toBe("running");
});

// With real agent output present, a done session stays done on both paths.
test("[regression] merge with agent activity keeps done", () => {
	const incoming = task({ status: "done", events: [agentMessage] });
	const current = task({ status: "done", events: [agentMessage] });
	expect(mergeClientTask(incoming, current).status).toBe("done");
});

// 详情已 done + 有产出，列表 summary 仍报 running 时不能回退，否则会每 2.5s 重连 stream 并重复 fetchSession。
test("[regression] list-path merge preserves done when summary still says running", () => {
	const incoming = task({ status: "running", events: [] });
	const current = task({ status: "done", events: [agentMessage] });
	expect(mergeClientTask(incoming, current).status).toBe("done");
});
