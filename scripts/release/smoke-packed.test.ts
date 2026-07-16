import { describe, expect, test } from "bun:test";
import { packedFilename } from "./smoke-packed.ts";

describe("npm pack output", () => {
	test("accepts the npm 10 and 11 array format", () => {
		expect(packedFilename('[{"filename":"sdk.tgz"}]', "sdk")).toBe("sdk.tgz");
	});

	test("accepts the npm 12 package-map format", () => {
		expect(packedFilename('{"@openagentpack/sdk":{"filename":"sdk.tgz"}}', "sdk")).toBe("sdk.tgz");
	});

	test("rejects ambiguous output", () => {
		expect(() => packedFilename("[]", "sdk")).toThrow("Unexpected npm pack output for sdk");
	});
});
