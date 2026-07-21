import { describe, expect, test } from "bun:test";
import { mapSession } from "../../src/internal/providers/qoder/mapper.ts";
import type { SessionBindings } from "../../src/internal/types/session.ts";
import { resolveSandboxMountPath } from "../../src/internal/utils/sandbox-mount.ts";

function bindings(overrides: Partial<SessionBindings> = {}): SessionBindings {
	return {
		agent_id: "agent_1",
		environment_id: "env_1",
		vault_ids: [],
		memory_store_ids: [],
		files: [],
		...overrides,
	};
}

describe("qoder mapSession file resources", () => {
	test("uploaded file mount_path is prefixed with /data", () => {
		const body = mapSession(bindings({ files: [{ file_id: "f1", mount_path: "uploads/report.pdf" }] })) as {
			resources?: { type: string; file_id: string; mount_path: string }[];
		};
		const file = body.resources?.find((r) => r.type === "file");
		expect(file?.mount_path).toBe("/data/uploads/report.pdf");
	});

	test("mapper and resolveSandboxMountPath agree (single source of truth)", () => {
		const sent = "uploads/nested/x.txt";
		const body = mapSession(bindings({ files: [{ file_id: "f1", mount_path: sent }] })) as {
			resources?: { type: string; mount_path: string }[];
		};
		const file = body.resources?.find((r) => r.type === "file");
		expect(file?.mount_path).toBe(resolveSandboxMountPath("qoder", sent));
	});
});
