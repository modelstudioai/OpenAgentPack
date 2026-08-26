import { defineConfig } from "tsup";

export default defineConfig({
	entry: { index: "src/index.ts" },
	format: ["esm"],
	dts: {
		compilerOptions: {
			ignoreDeprecations: "6.0",
			types: ["node", "bun"],
		},
	},
	clean: true,
	target: "es2022",
	external: ["@openagentpack/sdk"],
});
