import { describe, expect, test } from "bun:test";
import { deriveStatePath } from "../../src/internal/utils/paths.ts";

describe("deriveStatePath", () => {
	test(".yaml extension", () => {
		expect(deriveStatePath("agents.yaml")).toBe("agents.state.json");
	});

	test(".yml extension", () => {
		expect(deriveStatePath("my-project.yml")).toBe("my-project.state.json");
	});

	test("absolute path with .yaml", () => {
		expect(deriveStatePath("/home/user/project/agents.yaml")).toBe("/home/user/project/agents.state.json");
	});

	test("absolute path with .yml", () => {
		expect(deriveStatePath("/home/user/project/config.yml")).toBe("/home/user/project/config.state.json");
	});

	test("hyphenated config name", () => {
		expect(deriveStatePath("agents-full.yaml")).toBe("agents-full.state.json");
	});

	test("non-yaml extension appends .state.json", () => {
		expect(deriveStatePath("config.toml")).toBe("config.toml.state.json");
	});

	test("no extension appends .state.json", () => {
		expect(deriveStatePath("config")).toBe("config.state.json");
	});

	test("case-insensitive extension", () => {
		expect(deriveStatePath("config.YAML")).toBe("config.state.json");
		expect(deriveStatePath("config.YML")).toBe("config.state.json");
	});
});
