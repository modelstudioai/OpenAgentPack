import { describe, expect, test } from "bun:test";
import { ProjectMutationCoordinator } from "../src/services/project-mutations";

describe("ProjectMutationCoordinator", () => {
	test("publishes one project-wide mutation and rejects concurrent writers", () => {
		const coordinator = new ProjectMutationCoordinator();
		const snapshots: Array<string | null> = [];
		coordinator.subscribe((snapshot) => snapshots.push(snapshot?.kind ?? null));
		const lease = coordinator.acquire("project_apply");
		lease.setOperationId("operation-1");

		expect(coordinator.getSnapshot()).toMatchObject({ kind: "project_apply", operation_id: "operation-1" });
		expect(() => coordinator.acquire("declaration_write")).toThrow(/already running/i);
		lease.release();
		expect(coordinator.getSnapshot()).toBeNull();
		expect(snapshots).toEqual(["project_apply", "project_apply", null]);
	});

	test("ignores duplicate lease release", () => {
		const coordinator = new ProjectMutationCoordinator();
		const lease = coordinator.acquire("version_write");
		lease.release();
		lease.release();
		expect(coordinator.getSnapshot()).toBeNull();
	});
});
