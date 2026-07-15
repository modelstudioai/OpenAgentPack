/** @type {import("dependency-cruiser").IConfiguration} */
module.exports = {
	forbidden: [
		{
			name: "no-cli-to-server",
			severity: "error",
			comment: "The CLI host must consume shared behavior through @openagentpack/sdk, not by importing the API server.",
			from: { path: "^packages/cli/" },
			to: { path: "^apps/server/" },
		},
		{
			name: "no-server-to-cli",
			severity: "error",
			comment: "The API server must consume shared behavior through @openagentpack/sdk, not by importing CLI code.",
			from: { path: "^apps/server/" },
			to: { path: "^packages/cli/" },
		},
		{
			name: "no-sdk-to-hosts-or-apps",
			severity: "error",
			comment: "@openagentpack/sdk is the shared engine and must not depend on host packages or applications.",
			from: { path: "^packages/sdk/" },
			to: { path: "^(packages/cli|apps/server|apps/webui)/" },
		},
		{
			name: "no-sdk-deep-imports",
			severity: "error",
			comment: "Non-SDK code must use the @openagentpack/sdk public export surface instead of SDK internals.",
			from: {
				path: "^(apps|packages)/",
				pathNot: "^packages/sdk/",
			},
			to: {
				path: "^packages/sdk/src/internal/",
			},
		},
		{
			name: "no-webui-sdk-runtime-import",
			severity: "error",
			comment:
				"Browser-facing webui code may import @openagentpack/sdk types only; runtime imports would bundle SDK server/runtime code.",
			from: { path: "^apps/webui/src/" },
			to: { path: "^packages/sdk/" },
		},
	],
	options: {
		doNotFollow: {
			path: ["node_modules", "^packages/sdk/dist/"],
		},
		tsConfig: {
			fileName: "tsconfig.base.json",
		},
		// Keep post-compilation semantics: TypeScript `import type` edges are erased
		// and therefore allowed, while runtime imports remain visible and enforceable.
		tsPreCompilationDeps: false,
		combinedDependencies: true,
		moduleSystems: ["es6", "cjs"],
		detectProcessBuiltinModuleCalls: true,
		progress: {
			type: "none",
		},
		reporterOptions: {
			text: {
				highlightFocused: true,
			},
		},
	},
};
