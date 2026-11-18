import { describe, expect, test } from "bun:test";
import { app } from "@/app";

const HTTP_METHODS = new Set(["delete", "get", "head", "options", "patch", "post", "put", "trace"]);

function normalizePath(path: string): string {
	return path.replace(/:([^/]+)/g, "{$1}");
}

function runtimeOperations(): string[] {
	return [
		...new Set(
			app.routes
				.filter((route) => route.path.startsWith("/api/") && route.method !== "ALL")
				.map((route) => `${route.method.toUpperCase()} ${normalizePath(route.path)}`),
		),
	].sort();
}

async function documentedOperations(): Promise<string[]> {
	const response = await app.request("/openapi.json");
	expect(response.status).toBe(200);
	const document = (await response.json()) as {
		paths: Record<string, Record<string, unknown>>;
	};

	return Object.entries(document.paths)
		.flatMap(([path, pathItem]) =>
			Object.keys(pathItem)
				.filter((method) => HTTP_METHODS.has(method))
				.map((method) => `${method.toUpperCase()} ${path}`),
		)
		.sort();
}

describe("HTTP contract", () => {
	test("every runtime API operation is represented in OpenAPI", async () => {
		expect(await documentedOperations()).toEqual(runtimeOperations());
	});

	test("documents the usage agent version as a nullable string", async () => {
		const response = await app.request("/openapi.json");
		expect(response.status).toBe(200);
		const document = (await response.json()) as {
			components: {
				schemas: { GetUsageSummaryRequest: { oneOf: Array<{ properties: Record<string, unknown> }> } };
			};
		};
		const agent = document.components.schemas.GetUsageSummaryRequest.oneOf.find(
			({ properties }) => "agent_version" in properties,
		);
		expect(agent?.properties.agent_version).toMatchObject({ type: "string", nullable: true });
	});

	test("the committed OpenAPI snapshot matches the runtime document", async () => {
		const response = await app.request("/openapi.json");
		expect(response.status).toBe(200);
		const runtimeDocument = await response.json();
		const committedDocument = await Bun.file(new URL("../openapi.json", import.meta.url)).json();
		expect(committedDocument).toEqual(runtimeDocument);
	});
});
