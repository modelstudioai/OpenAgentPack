import { describe, expect, test } from "bun:test";
import { snapshotVersion } from "./snapshot.ts";

describe("beta snapshot version", () => {
	test("is deterministic and valid SemVer", () => {
		expect(snapshotVersion("123456789", "A1B2C3D99887766")).toBe("0.0.0-beta.run-123456789.sha-a1b2c3d");
	});

	test("rejects ambiguous inputs", () => {
		expect(() => snapshotVersion("0", "a1b2c3d")).toThrow("run ID");
		expect(() => snapshotVersion("123456789", "not-a-sha")).toThrow("sha");
	});
});
