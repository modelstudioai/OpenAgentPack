import { describe, expect, test } from "bun:test";
import { snapshotVersion } from "./snapshot.ts";

describe("beta snapshot version", () => {
	test("uses the workspace base version, short SHA, ref identity, and UTC date", () => {
		expect(snapshotVersion("1.2.3", "A1B2C3D99887766", "main", new Date("2026-07-20T23:59:59Z"))).toBe(
			"1.2.3-beta-a1b2c3d-0d6e4079-20260720",
		);
		expect(snapshotVersion("1.2.3", "A1B2C3D99887766", "feat/foo_bar")).not.toBe(
			snapshotVersion("1.2.3", "A1B2C3D99887766", "feat/foo-bar"),
		);
	});

	test("rejects ambiguous inputs", () => {
		expect(() => snapshotVersion("1.2.3-beta.0", "a1b2c3d", "main")).toThrow("base version");
		expect(() => snapshotVersion("1.2.3", "not-a-sha", "main")).toThrow("sha");
		expect(() => snapshotVersion("1.2.3", "a1b2c3d", "")).toThrow("ref");
		expect(() => snapshotVersion("1.2.3", "a1b2c3d", "main", new Date("invalid"))).toThrow("date");
	});
});
