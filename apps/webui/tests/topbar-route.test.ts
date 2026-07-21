import { describe, expect, test } from "bun:test";
import { pathnameForView, urlForView, viewFromPathname } from "../src/lib/topbar-route";

describe("viewFromPathname", () => {
	test("root is home", () => {
		expect(viewFromPathname("/")).toBe("home");
	});

	test("/resources is resources", () => {
		expect(viewFromPathname("/resources")).toBe("resources");
	});

	test("/schedule is schedule", () => {
		expect(viewFromPathname("/schedule")).toBe("schedule");
	});

	test("nested resources path", () => {
		expect(viewFromPathname("/cli_studio/resources")).toBe("resources");
	});

	test("nested schedule path", () => {
		expect(viewFromPathname("/cli_studio/schedule")).toBe("schedule");
	});

	test("trailing slash on resources", () => {
		expect(viewFromPathname("/resources/")).toBe("resources");
	});
});

describe("pathnameForView", () => {
	test("home from /resources", () => {
		expect(pathnameForView("home", "/resources")).toBe("/");
	});

	test("resources from /", () => {
		expect(pathnameForView("resources", "/")).toBe("/resources");
	});

	test("schedule from /", () => {
		expect(pathnameForView("schedule", "/")).toBe("/schedule");
	});

	test("resources from nested host path", () => {
		expect(pathnameForView("resources", "/cli_studio")).toBe("/cli_studio/resources");
	});

	test("home from nested resources path", () => {
		expect(pathnameForView("home", "/cli_studio/resources")).toBe("/cli_studio");
	});

	test("home from nested schedule path", () => {
		expect(pathnameForView("home", "/cli_studio/schedule")).toBe("/cli_studio");
	});

	test("switches between resources and schedule", () => {
		expect(pathnameForView("schedule", "/cli_studio/resources")).toBe("/cli_studio/schedule");
		expect(pathnameForView("resources", "/cli_studio/schedule")).toBe("/cli_studio/resources");
	});

	test("idempotent when already on target view", () => {
		expect(pathnameForView("resources", "/cli_studio/resources")).toBe("/cli_studio/resources");
		expect(pathnameForView("schedule", "/cli_studio/schedule")).toBe("/cli_studio/schedule");
		expect(pathnameForView("home", "/cli_studio")).toBe("/cli_studio");
	});
});

describe("urlForView", () => {
	test("preserves search and hash", () => {
		expect(
			urlForView("resources", {
				pathname: "/cli_studio",
				search: "?foo=1",
				hash: "#bar",
			}),
		).toBe("/cli_studio/resources?foo=1#bar");
	});
});
