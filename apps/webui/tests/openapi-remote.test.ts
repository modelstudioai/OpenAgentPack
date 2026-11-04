import { expect, test } from "bun:test";
import { createRequire } from "node:module";
import openapiTS, { astToString } from "openapi-typescript";

const require = createRequire(import.meta.url);
const requireOpenapi = createRequire(require.resolve("openapi-typescript"));
const { createConfig } = requireOpenapi("@redocly/openapi-core");

test("OpenAPI generation applies matching HTTP headers to a remote schema", async () => {
	const calls: Array<{ url: string; headers: Headers }> = [];
	const redocly = await createConfig({
		resolve: {
			http: {
				headers: [
					{ matches: "https://schema.test/**", name: "Authorization", value: "Bearer schema-test-key" },
					{ matches: "https://other.test/**", name: "X-Other-Key", value: "other-test-key" },
				],
			},
		},
	});
	redocly.resolve.http.customFetch = async (url: string, init?: RequestInit) => {
		calls.push({ url, headers: new Headers(init?.headers) });
		return Response.json({
			openapi: "3.0.0",
			info: { title: "Remote schema", version: "1.0.0" },
			paths: {},
			components: {
				schemas: {
					User: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
				},
			},
		});
	};

	const output = astToString(await openapiTS(new URL("https://schema.test/openapi.json"), { redocly }));

	expect(calls).toHaveLength(1);
	expect(calls[0]?.url).toBe("https://schema.test/openapi.json");
	expect(calls[0]?.headers.get("Authorization")).toBe("Bearer schema-test-key");
	expect(calls[0]?.headers.has("X-Other-Key")).toBe(false);
	expect(output).toContain("name: string");
});
