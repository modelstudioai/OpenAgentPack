import { defineConfig } from "tsup";

export default defineConfig({
	entry: ["src/program.ts", "bin/agents.ts"],
	format: ["esm"],
	dts: {
		compilerOptions: {
			ignoreDeprecations: "6.0",
		},
	},
	clean: true,
	target: "esnext",
	external: ["@openagentpack/sdk"],
});
