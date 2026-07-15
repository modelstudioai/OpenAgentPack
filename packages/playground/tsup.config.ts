import { fileURLToPath } from "node:url";
import { defineConfig } from "tsup";

// Server routes import via the `@/*` alias (its own tsconfig paths). tsup/esbuild has no
// knowledge of that tsconfig, so re-declare the alias here to resolve bundled server sources.
const serverSrc = fileURLToPath(new URL("../../apps/server/src", import.meta.url));

export default defineConfig({
	entry: { "bin/playground": "bin/playground.ts" },
	format: ["esm"],
	clean: true,
	target: "esnext",
	// Shared singletons must resolve to one runtime instance: @hono/zod-openapi patches zod's
	// prototype with `.openapi()`, and the external @openagentpack/sdk builds its schemas from the same
	// zod — bundling a second copy would leave sdk's schemas without the patch.
	external: ["@openagentpack/sdk", "hono", "@hono/node-server", "@hono/zod-openapi", "zod"],
	// Inline the private workspace packages so the published artifact is self-contained.
	noExternal: [/@openagentpack\/(server|playbooks)/],
	esbuildOptions(options) {
		options.alias = { ...(options.alias ?? {}), "@": serverSrc };
	},
});
