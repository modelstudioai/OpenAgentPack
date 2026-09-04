import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import playgroundConfig from "../../packages/playground/tsup.config.ts";

function runtimeDependencies(relativePath: string): Record<string, string> {
	const manifest = JSON.parse(readFileSync(new URL(relativePath, import.meta.url), "utf8")) as {
		dependencies: Record<string, string>;
	};
	return manifest.dependencies;
}

describe("published Playground dependency boundary", () => {
	test("declares the bundled private Server's runtime dependencies", () => {
		const serverDependencies = runtimeDependencies("../../apps/server/package.json");
		const playgroundDependencies = runtimeDependencies("../../packages/playground/package.json");
		for (const [name, versionRange] of Object.entries(serverDependencies)) {
			expect(playgroundDependencies[name]).toBe(versionRange);
		}
	});

	test("keeps public project libraries and CommonJS YAML external to the ESM bundle", () => {
		if (typeof playgroundConfig === "function" || Array.isArray(playgroundConfig)) {
			throw new Error("Expected a single Playground build configuration");
		}
		for (const name of [
			"@openagentpack/sdk",
			"@openagentpack/project-versions",
			"@openagentpack/project-workspace",
			"yaml",
		]) {
			expect(playgroundConfig.external).toContain(name);
		}
	});
});
