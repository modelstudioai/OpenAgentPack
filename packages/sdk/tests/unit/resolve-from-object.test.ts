import { expect, test } from "bun:test";
import { UserError } from "../../src/internal/errors.ts";
import { resolveProjectConfigFromObject } from "../../src/internal/parser/index.ts";

function validRawConfig() {
	return {
		version: "1",
		providers: { bailian: { api_key: "sk-test", workspace_id: "ws-test" } },
		defaults: { provider: "bailian" },
		agents: {
			designer: {
				model: "qwen3.7-max",
				instructions: "inline instructions, no file reference",
			},
		},
	};
}

test("resolves a valid in-memory config and stamps _resolved", async () => {
	const loaded = await resolveProjectConfigFromObject(validRawConfig(), { projectName: "server" });
	expect(loaded.projectName).toBe("server");
	expect((loaded.config as { _resolved?: boolean })._resolved).toBe(true);
	expect(loaded.config.agents?.designer?.model).toBe("qwen3.7-max");
});

test("throws UserError listing field paths on schema failure", async () => {
	const bad = { version: "1" }; // missing required providers
	let caught: unknown;
	try {
		await resolveProjectConfigFromObject(bad, { projectName: "server" });
	} catch (err) {
		caught = err;
	}
	expect(caught).toBeInstanceOf(UserError);
	expect((caught as UserError).message).toContain("providers");
});

test("inline instructions are a file-resolver no-op", async () => {
	const raw = validRawConfig();
	const loaded = await resolveProjectConfigFromObject(raw, { projectName: "server" });
	expect(loaded.config.agents?.designer?.instructions).toBe("inline instructions, no file reference");
});

test("rejects permission keys that do not identify an enabled builtin", async () => {
	const raw = validRawConfig();
	(raw.agents.designer as Record<string, unknown>).tools = { builtin: ["Read"], permissions: { Bash: "ask" } };
	await expect(resolveProjectConfigFromObject(raw, { projectName: "server" })).rejects.toThrow(/not enabled/);
});

test("rejects duplicate permission keys after normalization", async () => {
	const raw = validRawConfig();
	(raw.agents.designer as Record<string, unknown>).tools = {
		builtin: ["WebSearch"],
		permissions: { WebSearch: "allow", web_search: "ask" },
	};
	await expect(resolveProjectConfigFromObject(raw, { projectName: "server" })).rejects.toThrow(/duplicates/);
});
