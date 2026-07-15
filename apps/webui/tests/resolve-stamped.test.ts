import { describe, expect, test } from "bun:test";
import { resolveStampedResource } from "../src/lib/resolve-stamped";

interface Item {
	id: string;
	stamp?: boolean;
	updatedAt?: string | number | null;
}

const matches = (item: Item) => item.stamp === true;
const updatedAt = (item: Item) => item.updatedAt;

describe("resolveStampedResource (webui twin)", () => {
	test("empty list → no winner, no duplicates", () => {
		expect(resolveStampedResource<Item>([], { matches, updatedAt })).toEqual({ winner: undefined, duplicates: [] });
	});

	test("single match → that item wins", () => {
		const items: Item[] = [{ id: "a" }, { id: "b", stamp: true, updatedAt: "2026-01-01" }];
		const res = resolveStampedResource(items, { matches, updatedAt });
		expect(res.winner?.id).toBe("b");
		expect(res.duplicates).toEqual([]);
	});

	test("multiple matches → most recently updated wins, rest are duplicates", () => {
		const items: Item[] = [
			{ id: "old", stamp: true, updatedAt: "2026-01-01T00:00:00Z" },
			{ id: "new", stamp: true, updatedAt: "2026-06-01T00:00:00Z" },
			{ id: "mid", stamp: true, updatedAt: "2026-03-01T00:00:00Z" },
		];
		const res = resolveStampedResource(items, { matches, updatedAt });
		expect(res.winner?.id).toBe("new");
		expect(res.duplicates.map((d) => d.id)).toEqual(["mid", "old"]);
	});

	test("null / garbage updatedAt → epoch 0, no crash", () => {
		const items: Item[] = [
			{ id: "garbage", stamp: true, updatedAt: "not-a-date" },
			{ id: "null", stamp: true, updatedAt: null },
			{ id: "real", stamp: true, updatedAt: "2026-01-01T00:00:00Z" },
		];
		expect(resolveStampedResource(items, { matches, updatedAt }).winner?.id).toBe("real");
	});

	test("equal timestamps → stable: earlier in input wins", () => {
		const items: Item[] = [
			{ id: "first", stamp: true, updatedAt: "2026-01-01T00:00:00Z" },
			{ id: "second", stamp: true, updatedAt: "2026-01-01T00:00:00Z" },
		];
		const res = resolveStampedResource(items, { matches, updatedAt });
		expect(res.winner?.id).toBe("first");
		expect(res.duplicates.map((d) => d.id)).toEqual(["second"]);
	});
});
