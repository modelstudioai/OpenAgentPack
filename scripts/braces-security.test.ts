import { describe, expect, test } from "bun:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const braces = require("braces");

type BraceNode = {
	type: string;
	value?: string;
	nodes?: BraceNode[];
	parent?: BraceNode;
	queue?: unknown[];
};

function nestedAst(depth: number): BraceNode {
	let node: BraceNode = { type: "text", value: "x" };
	for (let level = 0; level < depth; level++) node = { type: "root", nodes: [node] };
	return node;
}

describe("vendored braces security backport", () => {
	test("the Changesets dependency chain loads the guarded braces package", () => {
		let consumerRequire = createRequire(require.resolve("@changesets/cli/package.json"));
		for (const dependency of ["@changesets/apply-release-plan", "@changesets/git", "micromatch"]) {
			consumerRequire = createRequire(consumerRequire.resolve(dependency));
		}
		const consumedBraces = consumerRequire("braces");
		expect(consumerRequire("braces/package.json").name).toBe("@openagentpack/braces");
		expect(consumedBraces.expand("{a,b}")).toEqual(["a", "b"]);
		expect(() => consumedBraces(`${"{".repeat(4000)}x${"}".repeat(4000)}`)).toThrow(SyntaxError);
	});

	test("preserves the expected public API and normal expansions", () => {
		expect(braces("a/{b,c}/d")).toEqual(["a/(b|c)/d"]);
		expect(braces.compile("a/{b,c}/d")).toBe("a/(b|c)/d");
		expect(braces.expand("a/{1..3}/{x,y}")).toEqual(["a/1/x", "a/1/y", "a/2/x", "a/2/y", "a/3/x", "a/3/y"]);
		expect(braces.expand("{a,{b,c}}", { nodupes: true })).toEqual(["a", "b", "c"]);
		expect(braces.expand("{a,,a,b}", { noempty: true, nodupes: true })).toEqual(["a", "b"]);
		expect(braces.expand("{03..01}")).toEqual(["03", "02", "01"]);
		expect(braces.expand("{1..5..2}")).toEqual(["1", "3", "5"]);
		expect(braces.expand("{a..c}")).toEqual(["a", "b", "c"]);
		expect(braces.expand("{}")).toEqual(["{}"]);
		expect(braces.expand("\\{a,b\\}")).toEqual(["{a,b}"]);
		expect(braces("")).toEqual([""]);
		expect(braces([])).toEqual([]);
		expect(braces.stringify(braces.parse("x/{a,b}/(c)"))).toBe("x/{a,b}/(c)");
	});

	for (const operation of ["parse", "compile", "expand", "stringify", "create"] as const) {
		test(`${operation} rejects deeply nested strings under the existing character limit`, () => {
			for (const pattern of [
				`${"{".repeat(4000)}a,b${"}".repeat(4000)}`,
				`${"(".repeat(4000)}x${")".repeat(4000)}`,
				`${"{(".repeat(2000)}x${")}".repeat(2000)}`,
				`${"{".repeat(4000)}x`,
			])
				expect(() => braces[operation](pattern)).toThrow(SyntaxError);
		});
	}

	test("the callable API also rejects deep patterns", () => {
		const pattern = `${"{".repeat(4000)}x${"}".repeat(4000)}`;
		expect(() => braces(pattern)).toThrow(SyntaxError);
		expect(() => braces(pattern, { expand: true })).toThrow(SyntaxError);
		expect(() => braces(["normal", pattern])).toThrow(SyntaxError);
	});

	test("counts mixed braces and parentheses towards the fixed parser limit", () => {
		const accepted = `${"{(".repeat(64)}x${")}".repeat(64)}`;
		expect(() => braces.parse(accepted)).not.toThrow();
		expect(() => braces.compile(accepted)).not.toThrow();
		expect(() => braces.parse(`(${accepted})`)).toThrow(SyntaxError);
		expect(() => braces.parse("(".repeat(129), { maxDepth: Infinity })).toThrow(SyntaxError);
	});

	for (const operation of ["compile", "expand", "stringify"] as const) {
		test(`${operation} rejects deep and cyclic hand-built ASTs`, () => {
			expect(() => braces[operation](nestedAst(12000))).toThrow(SyntaxError);
			const direct: BraceNode = { type: "root", nodes: [] };
			direct.nodes!.push(direct);
			expect(() => braces[operation](direct)).toThrow(SyntaxError);
			const indirect: BraceNode = { type: "root", nodes: [] };
			indirect.nodes!.push({ type: "root", nodes: [indirect] });
			expect(() => braces[operation](indirect)).toThrow(SyntaxError);
		});

		test(`${operation} enforces the child-edge depth boundary`, () => {
			expect(() => braces[operation](nestedAst(129))).not.toThrow();
			expect(() => braces[operation](nestedAst(130))).toThrow(SyntaxError);
		});

		test(`${operation} bounds repeated visits through a shared DAG`, () => {
			let node: BraceNode = { type: "text", value: "x" };
			for (let level = 0; level < 24; level++) node = { type: "root", nodes: [node, node] };
			expect(() => braces[operation](node)).toThrow(SyntaxError);
		});

		test(`${operation} permits ordinary shared acyclic leaves`, () => {
			const leaf: BraceNode = { type: "text", value: "a" };
			const result = braces[operation]({ type: "root", nodes: [leaf, leaf] });
			expect(result).toEqual(operation === "expand" ? ["aa"] : "aa");
		});

		test(`${operation} rejects malformed child lists and recursive value arrays`, () => {
			expect(() => braces[operation]({ type: "root", nodes: "bad" })).toThrow(SyntaxError);
			const recursive: unknown[] = [];
			recursive.push(recursive);
			expect(() => braces[operation]({ type: "root", nodes: [{ type: "text", value: recursive }] })).toThrow(
				SyntaxError,
			);
		});
	}

	test("expansion ignores cyclic parent metadata and external queues", () => {
		const foreignQueue: unknown[] = [];
		foreignQueue.push(foreignQueue);
		const child: BraceNode = { type: "paren", nodes: [{ type: "text", value: "x" }] };
		child.parent = child;
		child.queue = foreignQueue;
		expect(braces.expand({ type: "root", nodes: [child] })).toEqual(["x"]);
		expect(foreignQueue[0]).toBe(foreignQueue);
		const untrustedParent: BraceNode = { type: "paren", nodes: [{ type: "text", value: "y" }] };
		Object.defineProperty(untrustedParent, "parent", {
			get: () => {
				throw new Error("parent must not be read");
			},
		});
		expect(braces.expand({ type: "root", nodes: [untrustedParent] })).toEqual(["y"]);
	});

	test("expands a standalone parenthesis subtree without stale parent queues", () => {
		const parsed = braces.parse("(a)");
		expect(braces.expand(parsed.nodes[1])).toEqual(["(a)"]);
	});
});
