import { describe, expect, test } from "bun:test";
import { pathnameForView, urlForView, viewFromPathname } from "../src/lib/topbar-route";

describe("viewFromPathname", () => {
	test("root is home", () => {
		expect(viewFromPathname("/")).toBe("home");
	});

	test("/resources is resources", () => {
		expect(viewFromPathname("/resources")).toBe("resources");
	});

	test("/deployments is deployments", () => {
		expect(viewFromPathname("/deployments")).toBe("deployments");
	});

	test("nested resources path", () => {
		expect(viewFromPathname("/cli_studio/resources")).toBe("resources");
	});

	test("nested deployments path", () => {
		expect(viewFromPathname("/cli_studio/deployments")).toBe("deployments");
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

	test("deployments from /", () => {
		expect(pathnameForView("deployments", "/")).toBe("/deployments");
	});

	test("resources from nested host path", () => {
		expect(pathnameForView("resources", "/cli_studio")).toBe("/cli_studio/resources");
	});

	test("home from nested resources path", () => {
		expect(pathnameForView("home", "/cli_studio/resources")).toBe("/cli_studio");
	});

	test("home from nested deployments path", () => {
		expect(pathnameForView("home", "/cli_studio/deployments")).toBe("/cli_studio");
	});

	test("switches between resources and deployments", () => {
		expect(pathnameForView("deployments", "/cli_studio/resources")).toBe("/cli_studio/deployments");
		expect(pathnameForView("resources", "/cli_studio/deployments")).toBe("/cli_studio/resources");
	});

	test("idempotent when already on target view", () => {
		expect(pathnameForView("resources", "/cli_studio/resources")).toBe("/cli_studio/resources");
		expect(pathnameForView("deployments", "/cli_studio/deployments")).toBe("/cli_studio/deployments");
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
