import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeResourceHash } from "../../src/internal/planner/hasher.ts";
import { buildPlan } from "../../src/internal/planner/planner.ts";
import type { ProjectConfig } from "../../src/internal/types/config.ts";
import type { ResourceAddress, StateFile } from "../../src/internal/types/state.ts";
import { addressKey } from "../../src/internal/types/state.ts";
import "../../src/internal/providers/qoder/index.ts";

function stateLookup(state: StateFile) {
	return {
		getResource(address: ResourceAddress) {
			return state.resources.find((resource) => addressKey(resource.address) === addressKey(address));
		},
	};
}

describe("local file content hashing", () => {
	test("plans an update when a declared File's content changes at the same source path", async () => {
		const directory = mkdtempSync(join(tmpdir(), "agents-file-hash-"));
		try {
			const configPath = join(directory, "agents.yaml");
			const sourcePath = join(directory, "payload.bin");
			writeFileSync(sourcePath, new Uint8Array([0, 1, 2, 3]));
			const config: ProjectConfig = {
				version: "1",
				providers: { qoder: {} },
				defaults: { provider: "qoder" },
				files: { payload: { source: "payload.bin" } },
			};
			const address: ResourceAddress = { type: "file", name: "payload", provider: "qoder" };
			const originalHash = await computeResourceHash(address, config, configPath);
			const state: StateFile = {
				resources: [{ address, remote_id: "file_1", content_hash: originalHash }],
			};

			writeFileSync(sourcePath, new Uint8Array([0, 1, 2, 4]));

			const changedHash = await computeResourceHash(address, config, configPath);
			expect(changedHash).not.toBe(originalHash);
			const plan = await buildPlan(config, state, { configPath });
			expect(plan.actions.find((action) => addressKey(action.address) === addressKey(address))?.action).toBe("update");
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("plans an update when a Deployment source file changes at the same path", async () => {
		const directory = mkdtempSync(join(tmpdir(), "agents-deployment-hash-"));
		try {
			const configPath = join(directory, "agents.yaml");
			const sourcePath = join(directory, "report.md");
			writeFileSync(sourcePath, "first report\n");
			const config: ProjectConfig = {
				version: "1",
				providers: { qoder: {} },
				defaults: { provider: "qoder" },
				environments: { dev: { config: { type: "cloud" } } },
				agents: {
					reporter: {
						model: "ultimate",
						instructions: "Create a report.",
						environment: "dev",
					},
				},
				deployments: {
					daily: {
						agent: "reporter",
						initial_events: [{ type: "user.message", content: "Run the report." }],
						resources: [{ type: "file", source: "report.md", mount_path: "/data/report.md" }],
					},
				},
			};
			const environment: ResourceAddress = { type: "environment", name: "dev", provider: "qoder" };
			const agent: ResourceAddress = { type: "agent", name: "reporter", provider: "qoder" };
			const deployment: ResourceAddress = { type: "deployment", name: "daily", provider: "qoder" };
			const state: StateFile = { resources: [] };
			state.resources.push({
				address: environment,
				remote_id: "env_1",
				content_hash: await computeResourceHash(environment, config, configPath, stateLookup(state)),
			});
			state.resources.push({
				address: agent,
				remote_id: "agent_1",
				content_hash: await computeResourceHash(agent, config, configPath, stateLookup(state)),
			});
			const originalHash = await computeResourceHash(deployment, config, configPath, stateLookup(state));
			state.resources.push({ address: deployment, remote_id: "depl_1", content_hash: originalHash });

			writeFileSync(sourcePath, "updated report\n");

			const changedHash = await computeResourceHash(deployment, config, configPath, stateLookup(state));
			expect(changedHash).not.toBe(originalHash);
			const plan = await buildPlan(config, state, { configPath });
			expect(plan.actions.find((action) => addressKey(action.address) === addressKey(deployment))?.action).toBe(
				"update",
			);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
