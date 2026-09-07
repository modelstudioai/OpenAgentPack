import { expect, test } from "bun:test";
import { collectAgentAddresses } from "../../src/internal/core/agent-runtime.ts";
import { validateProjectConfig } from "../../src/internal/core/validate-config.ts";
import { resolveTemplateRefs } from "../../src/internal/executor/resolver.ts";
import { projectConfigSchema } from "../../src/internal/parser/schema.ts";
import { computeResourceHash } from "../../src/internal/planner/hasher.ts";
import { buildSessionBindings } from "../../src/internal/session/session-manager.ts";
import { StateManager } from "../../src/internal/state/state-manager.ts";
import type { ProjectConfig } from "../../src/internal/types/config.ts";

function fixture(): ProjectConfig {
	return {
		version: "1",
		providers: { qoder: { api_key: "test" } },
		defaults: { provider: "qoder" },
		environments: { cloud: { environment_id: "env_external", config: { type: "cloud" } } },
		files: { handbook: { source: "./handbook.md" }, input: { source: "./input.txt" } },
		agents: {
			assistant: {
				model: "auto",
				instructions: "Help.",
				environment: "cloud",
				delivery: { qoder: { type: "forward" } },
				files: ["handbook", { file: "input", mount_path: "/data/input.txt" }],
			},
		},
	};
}

function makeState() {
	const state = StateManager.initialize("/tmp/agent-file-references.json");
	for (const name of ["handbook", "input"]) {
		state.setResource({
			address: { type: "file", name, provider: "qoder" },
			remote_id: `file_${name}`,
			content_hash: "test",
		});
	}
	state.setResource({
		address: { type: "template", name: "assistant", provider: "qoder" },
		remote_id: "tmpl_assistant",
		content_hash: "test",
	});
	return state;
}

test("both Agent File forms survive parsing, validation, and dependency collection", () => {
	const config = projectConfigSchema.parse(fixture());
	expect(config.agents!.assistant!.files).toEqual(fixture().agents!.assistant!.files);
	expect(validateProjectConfig(config)).toEqual([]);
	const files = collectAgentAddresses(config, "assistant", "qoder")
		.filter((address) => address.type === "file")
		.map((address) => address.name);
	expect(files.sort()).toEqual(["handbook", "input"]);
});

test("Template inheritance and Session mounts use their respective File references", () => {
	const config = fixture();
	const state = makeState();
	expect(resolveTemplateRefs("assistant", config, "qoder", state).file_ids).toEqual(["file_handbook"]);
	const bindings = buildSessionBindings("assistant", config, "qoder", state, { identityId: "identity_test" });
	expect(bindings.files).toEqual([{ file_id: "file_input", mount_path: "/data/input.txt" }]);
});

test("Template hashes track inherited Files while Session mount paths remain local", async () => {
	const config = fixture();
	const address = { type: "template", name: "assistant", provider: "qoder" } as const;
	const state = makeState();
	const original = await computeResourceHash(address, config, undefined, state);
	config.agents!.assistant!.files = ["handbook", { file: "input", mount_path: "/data/renamed.txt" }];
	expect(await computeResourceHash(address, config, undefined, state)).toBe(original);
	config.agents!.assistant!.files = [{ file: "input", mount_path: "/data/renamed.txt" }];
	expect(await computeResourceHash(address, config, undefined, state)).not.toBe(original);
});
