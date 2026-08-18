import { expect, test } from "bun:test";
import { buildYamlLineDiff } from "./yaml-diff";

test("buildYamlLineDiff renders a Git-style replacement with stable line numbers", () => {
	const diff = buildYamlLineDiff("agent:\n  model: old\n  enabled: true\n", "agent:\n  model: new\n  enabled: true\n");

	expect(diff.beforeLineCount).toBe(3);
	expect(diff.afterLineCount).toBe(3);
	expect(diff.lines).toEqual([
		{ kind: "context", text: "agent:", beforeLine: 1, afterLine: 1 },
		{ kind: "deletion", text: "  model: old", beforeLine: 2 },
		{ kind: "addition", text: "  model: new", afterLine: 2 },
		{ kind: "context", text: "  enabled: true", beforeLine: 3, afterLine: 3 },
	]);
});

test("buildYamlLineDiff handles insertions and deletions without phantom trailing lines", () => {
	const diff = buildYamlLineDiff("first\nremoved\nlast\n", "first\nadded one\nadded two\nlast\n");

	expect(diff.lines).toEqual([
		{ kind: "context", text: "first", beforeLine: 1, afterLine: 1 },
		{ kind: "deletion", text: "removed", beforeLine: 2 },
		{ kind: "addition", text: "added one", afterLine: 2 },
		{ kind: "addition", text: "added two", afterLine: 3 },
		{ kind: "context", text: "last", beforeLine: 3, afterLine: 4 },
	]);
});
