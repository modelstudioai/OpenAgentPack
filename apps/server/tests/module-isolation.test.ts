import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

describe("server test module isolation", () => {
	const orders = {
		"API routes before deployments": [
			"./tests/api-routes.test.ts",
			"./tests/deployments-manage.test.ts",
			"./tests/openapi-contract.test.ts",
			"./tests/runtime-config.test.ts",
		],
		"deployments before runtime config and routes": [
			"./tests/deployments-manage.test.ts",
			"./tests/runtime-config.test.ts",
			"./tests/api-routes.test.ts",
			"./tests/openapi-contract.test.ts",
		],
	};

	for (const [name, files] of Object.entries(orders)) {
		test(name, () => {
			// Each child shares one module cache across these suites. Do not run this
			// regression file in the child or isolate each individual test file.
			const child = Bun.spawnSync([process.execPath, "test", ...files], {
				cwd: resolve(import.meta.dirname, ".."),
				stdout: "pipe",
				stderr: "pipe",
				timeout: 10_000,
			});
			const output = `${child.stdout.toString()}\n${child.stderr.toString()}`;
			expect(child.exitCode, output).toBe(0);
		}, 15_000);
	}
});
