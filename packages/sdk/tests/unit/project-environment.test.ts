import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import {
	resolveProjectConfig,
	resolveProjectConfigFromObject,
} from "../../src/internal/parser/resolve-project-config.ts";

const rawConfig = {
	version: "1",
	providers: { bailian: {} },
	vaults: {
		secrets: {
			display_name: "Secrets",
			credentials: [
				{
					name: "test",
					type: "environment_variable",
					secret_name: "TOKEN",
					secret_value: `\${AGENTS_TEST_SCOPED_SECRET}`,
				},
			],
		},
	},
};

test("isolates concurrent project environments, preserves secret scalar syntax and honors process precedence", async () => {
	const previous = process.env.AGENTS_TEST_SCOPED_SECRET;
	delete process.env.AGENTS_TEST_SCOPED_SECRET;
	const directory = await mkdtemp(join(tmpdir(), "agents-env-test-"));
	try {
		const file = join(directory, "agents.yaml");
		await writeFile(file, stringify(rawConfig));
		const secrets = ["first\nwith: 'quotes' # and \\slashes", `second-\${literal}-value`];
		const results = await Promise.all(
			secrets.map((secret) => resolveProjectConfig(file, { environment: { AGENTS_TEST_SCOPED_SECRET: secret } })),
		);
		for (const [index, result] of results.entries())
			expect(result.config.vaults?.secrets?.credentials[0]).toMatchObject({ secret_value: secrets[index] });
		expect(process.env.AGENTS_TEST_SCOPED_SECRET).toBeUndefined();
		const unresolved = await resolveProjectConfig(file, { resolveEnv: false, environment: {} });
		expect(unresolved.config.vaults?.secrets?.credentials[0]).toMatchObject({
			secret_value: `\${AGENTS_TEST_SCOPED_SECRET}`,
		});
		await expect(resolveProjectConfig(file, { environment: {} })).rejects.toThrow("is not set");
		process.env.AGENTS_TEST_SCOPED_SECRET = "inherited";
		const loaded = await resolveProjectConfigFromObject(rawConfig, {
			projectName: "test",
			basePath: directory,
			resolveEnv: true,
			environment: { AGENTS_TEST_SCOPED_SECRET: "fallback" },
		});
		expect(loaded.config.vaults?.secrets?.credentials[0]).toMatchObject({ secret_value: "inherited" });
	} finally {
		if (previous === undefined) delete process.env.AGENTS_TEST_SCOPED_SECRET;
		else process.env.AGENTS_TEST_SCOPED_SECRET = previous;
		await rm(directory, { recursive: true, force: true });
	}
});
