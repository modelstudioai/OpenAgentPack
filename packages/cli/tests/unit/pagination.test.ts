import { describe, expect, test } from "bun:test";
import { fetchAllPages } from "../../src/utils/pagination.ts";

describe("fetchAllPages", () => {
	test("returns first page when all is false", async () => {
		const result = await fetchAllPages(async () => ({
			items: [1, 2],
			hasMore: true,
			nextPage: "page-2",
		}));

		expect(result.items).toEqual([1, 2]);
		expect(result.hasMore).toBe(true);
		expect(result.nextPage).toBe("page-2");
	});

	test("follows cursors when all is true", async () => {
		const pages: string[] = [];
		const result = await fetchAllPages(async (page) => {
			pages.push(page ?? "start");
			if (!page) return { items: ["a"], hasMore: true, nextPage: "p2" };
			if (page === "p2") return { items: ["b"], hasMore: false, nextPage: undefined };
			return { items: [], hasMore: false };
		}, true);

		expect(pages).toEqual(["start", "p2"]);
		expect(result.items).toEqual(["a", "b"]);
		expect(result.hasMore).toBe(false);
	});
});
