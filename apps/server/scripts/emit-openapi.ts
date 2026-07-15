import server from "../src/index";

const res = await server.fetch(new Request("http://local/openapi.json"));
if (!res.ok) {
	throw new Error(`Failed to build OpenAPI document: HTTP ${res.status}`);
}

const doc = await res.json();
const output = `${JSON.stringify(doc, null, 2)}\n`;
await Bun.write(new URL("../openapi.json", import.meta.url), output);

console.log("Wrote apps/server/openapi.json");
