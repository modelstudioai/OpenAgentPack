import { describe, expect, test } from "bun:test";
import { snapshotVersion } from "./snapshot.ts";

describe("beta snapshot version", () => {
	test("uses the workspace base version, short SHA, and UTC date", () => {
		expect(snapshotVersion("1.2.3", "A1B2C3D99887766", new Date("2026-07-20T23:59:59Z"))).toBe(
			"1.2.3-beta-a1b2c3d-20260720",
		);
	});

	test("rejects ambiguous inputs", () => {
		expect(() => snapshotVersion("1.2.3-beta.0", "a1b2c3d")).toThrow("base version");
		expect(() => snapshotVersion("1.2.3", "not-a-sha")).toThrow("sha");
		expect(() => snapshotVersion("1.2.3", "a1b2c3d", new Date("invalid"))).toThrow("date");
	});
});
