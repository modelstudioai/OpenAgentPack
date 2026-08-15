import { describe, expect, test } from "bun:test";
import { PlanTokenStore, ProjectOperationStore } from "../src/services/project-operations";

describe("project plan/apply protocol", () => {
	test("binds a plan token to Agent and project revision and consumes it once", () => {
		const store = new PlanTokenStore();
		const record = store.issue({
			agentId: "assistant",
			projectRevision: "revision-a",
			fingerprint: "fingerprint-a",
			destructive: false,
		});
		expect(store.require(record.token, "assistant", "revision-a").fingerprint).toBe("fingerprint-a");
		expect(() => store.require(record.token, "other", "revision-a")).toThrow(/stale/i);
		store.consume(record.token);
		expect(() => store.require(record.token, "assistant", "revision-a")).toThrow(/stale/i);
	});

	test("rejects a retained token record after project-wide invalidation", () => {
		const store = new PlanTokenStore();
		const record = store.issue({
			agentId: "assistant",
			projectRevision: "revision-a",
			fingerprint: "fingerprint-a",
			destructive: false,
		});
		store.invalidateAll();

		expect(() => store.require(record.token, "assistant", record.projectRevision)).toThrow(/stale/i);
	});

	test("serializes Agent apply operations and retains replayable progress", async () => {
		const store = new ProjectOperationStore();
		let finish: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const operation = store.create("assistant", async (reporter) => {
			reporter.emit("phase", { message: "planning" });
			await gate;
			return { ok: true };
		});
		await Bun.sleep(0);
		expect(() => store.create("assistant", async () => undefined)).toThrow(/already running/i);
		finish?.();
		await Bun.sleep(10);
		const completed = store.get(operation.id);
		expect(completed.status).toBe("completed");
		expect(completed.events.map((event) => event.type)).toContain("phase");
	});
});
