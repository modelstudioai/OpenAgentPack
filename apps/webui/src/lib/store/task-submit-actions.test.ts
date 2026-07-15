import { beforeEach, describe, expect, it } from "bun:test";
import type { Session } from "@openagentpack/sdk";
import type { SessionDetail } from "../domain/session-api";
import { getActiveTask, setActiveTask } from "./active-task-store";
import { getTaskStoreSnapshot } from "./task-client-store";
import { beginPendingTask, commitCreatedTask, failPendingTask } from "./task-submit-actions";
import { getToasts } from "./toast-store";

// The task stores are module-level singletons, so a test only inspects the entries it created
// (keyed by unique ids) rather than asserting on total counts, and resets the active-task
// selection between tests.
function detail(sessionId: string, overrides: Partial<Session> = {}): SessionDetail {
	return {
		session: { session_id: sessionId, status: "running", ...overrides },
		events: [],
	};
}

function toastById(id: string) {
	return getToasts().find((t) => t.id === id);
}

function taskById(id: string) {
	return getTaskStoreSnapshot().tasks.find((t) => t.id === id);
}

describe("task-submit-actions", () => {
	beforeEach(() => {
		setActiveTask(null);
	});

	describe("beginPendingTask", () => {
		it("opens the modal on an optimistic creating placeholder", () => {
			beginPendingTask({ id: "pending-1", prompt: "  hello  ", agentId: "role-a", attachedFiles: ["a.png"] });
			const active = getActiveTask();
			expect(active?.id).toBe("pending-1");
			expect(active?.modalKey).toBe("pending-1");
			expect(active?.status).toBe("creating");
			expect(active?.title).toBe("hello");
			expect(active?.agentId).toBe("role-a");
			expect(active?.attachedFiles).toEqual(["a.png"]);
			expect(active?.events).toEqual([]);
		});

		it("falls back to a default title for an empty prompt", () => {
			beginPendingTask({ id: "pending-empty", prompt: "   " });
			expect(getActiveTask()?.title).toBe("新任务");
		});
	});

	describe("commitCreatedTask", () => {
		it("adds the session to the list and raises a submitted toast", () => {
			commitCreatedTask(detail("sess-1"));
			expect(taskById("sess-1")).toBeDefined();
			expect(toastById("submitted-sess-1")?.variant).toBe("submitted");
		});

		it("hands the open placeholder over to the real session id, keeping the modal key", () => {
			beginPendingTask({ id: "pending-2", prompt: "make a poster", attachedFiles: ["src.png"] });
			commitCreatedTask(detail("sess-2"), "pending-2");
			const active = getActiveTask();
			expect(active?.id).toBe("sess-2");
			// Stable modal key survives the pending → real id handoff so the modal doesn't remount.
			expect(active?.modalKey).toBe("pending-2");
			// Optimistic prompt/attachments are preserved over the (empty) server echo.
			expect(active?.prompt).toBe("make a poster");
			expect(active?.attachedFiles).toEqual(["src.png"]);
		});

		it("leaves an unrelated open task untouched when the pending id does not match", () => {
			beginPendingTask({ id: "other-pending", prompt: "other" });
			commitCreatedTask(detail("sess-3"), "pending-does-not-match");
			expect(getActiveTask()?.id).toBe("other-pending");
		});
	});

	describe("failPendingTask", () => {
		it("marks a still-creating placeholder failed and raises a failure toast", () => {
			beginPendingTask({ id: "pending-3", prompt: "will fail" });
			failPendingTask("quota exceeded", "pending-3");
			const active = getActiveTask();
			expect(active?.status).toBe("failed");
			expect(active?.error).toBe("quota exceeded");
			expect(getToasts().some((t) => t.variant === "failed" && t.desc === "quota exceeded")).toBe(true);
		});

		it("uses a default message when none is given", () => {
			beginPendingTask({ id: "pending-4", prompt: "x" });
			failPendingTask("", "pending-4");
			expect(getActiveTask()?.error).toBe("请稍后重试");
		});

		it("does not overwrite a placeholder that already left the creating state", () => {
			beginPendingTask({ id: "pending-5", prompt: "y" });
			commitCreatedTask(detail("pending-5"), "pending-5"); // now no longer "creating"
			const before = getActiveTask();
			failPendingTask("late error", "pending-5");
			// The guard (status === "creating") prevents clobbering an already-committed task.
			expect(getActiveTask()?.status).toBe(before?.status);
			expect(getActiveTask()?.error).toBeUndefined();
		});

		it("still raises a toast when no pending id is supplied", () => {
			failPendingTask("network down");
			expect(getToasts().some((t) => t.variant === "failed" && t.desc === "network down")).toBe(true);
		});
	});
});
