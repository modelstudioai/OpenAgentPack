import { describe, expect, test } from "bun:test";
import { PlanTokenStore, ProjectOperationStore } from "../src/services/project-operations";

describe("project plan/apply protocol", () => {
	test("binds a plan token to Agent and project revision and consumes it once", () => {
		const store = new PlanTokenStore();
		const scope = { kind: "agent" as const, agentId: "assistant" };
		const record = store.issue({
			scope,
			projectRevision: "revision-a",
			fingerprint: "fingerprint-a",
			destructive: false,
		});
		expect(store.require(record.token, scope, "revision-a").fingerprint).toBe("fingerprint-a");
		expect(() => store.require(record.token, { kind: "agent", agentId: "other" }, "revision-a")).toThrow(/stale/i);
		store.consume(record.token);
		expect(() => store.require(record.token, scope, "revision-a")).toThrow(/stale/i);
	});

	test("rejects a retained token record after project-wide invalidation", () => {
		const store = new PlanTokenStore();
		const record = store.issue({
			scope: { kind: "project" },
			projectRevision: "revision-a",
			fingerprint: "fingerprint-a",
			destructive: false,
		});
		store.invalidateAll();

		expect(() => store.require(record.token, { kind: "project" }, record.projectRevision)).toThrow(/stale/i);
	});

	test("keeps Agent and Project tokens in separate scopes", () => {
		const store = new PlanTokenStore();
		const projectRecord = store.issue({
			scope: { kind: "project" },
			projectRevision: "revision-a",
			fingerprint: "fingerprint-a",
			destructive: true,
		});

		expect(store.require(projectRecord.token, { kind: "project" }, "revision-a").destructive).toBe(true);
		expect(() => store.require(projectRecord.token, { kind: "agent", agentId: "assistant" }, "revision-a")).toThrow(
			/stale/i,
		);
	});

	test("rejects expired plan tokens", () => {
		const originalNow = Date.now;
		let now = originalNow();
		Date.now = () => now;
		try {
			const store = new PlanTokenStore();
			const record = store.issue({
				scope: { kind: "project" },
				projectRevision: "revision-a",
				fingerprint: "fingerprint-a",
				destructive: false,
			});
			now += 11 * 60 * 1000;

			expect(() => store.require(record.token, { kind: "project" }, record.projectRevision)).toThrow(/stale/i);
		} finally {
			Date.now = originalNow;
		}
	});

	test("serializes Agent apply operations and retains replayable progress", async () => {
		const store = new ProjectOperationStore();
		let finish: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const operation = store.create({ kind: "agent", agentId: "assistant" }, async (reporter) => {
			reporter.emit("phase", { message: "planning" });
			await gate;
			return { ok: true };
		});
		await Bun.sleep(0);
		expect(() => store.create({ kind: "project" }, async () => undefined)).toThrow(/already running/i);
		finish?.();
		await Bun.sleep(10);
		const completed = store.get(operation.id);
		expect(completed.status).toBe("completed");
		expect(completed.events.map((event) => event.type)).toContain("phase");
	});
});
