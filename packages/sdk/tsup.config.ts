import { defineConfig } from "tsup";

export default defineConfig({
	entry: {
		index: "src/index.ts",
		"session-events": "src/session-events.ts",
		"scan-lifecycle": "src/scan-lifecycle.ts",
		"file-lifecycle": "src/file-lifecycle.ts",
	},
	format: ["esm"],
	dts: {
		compilerOptions: {
			ignoreDeprecations: "6.0",
			types: ["bun"],
		},
	},
	clean: true,
	// Keep the emitted syntax parseable by Node 18.17 (the package's engines
	// floor): esnext would let future syntax (e.g. `using`) leak into dist.
	target: "es2022",
});
