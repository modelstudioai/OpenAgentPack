import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const sdkSrc = fileURLToPath(new URL("../../packages/sdk/src", import.meta.url));
const playbooksSrc = fileURLToPath(new URL("../../packages/playbooks/src", import.meta.url));

// Dev-only: inject the playground runtime marker so `isPlaygroundMode()` is true
// under `vite` dev server (matches what the playground server does at runtime).
// Not applied to `vite build`, so production bundles are unaffected.
function playgroundMarkerDev(): Plugin {
	return {
		name: "playground-marker-dev",
		apply: "serve",
		transformIndexHtml(html) {
			if (html.includes('name="agents-runtime"')) return html;
			return html.replace("<head>", '<head>\n    <meta name="agents-runtime" content="playground" />');
		},
	};
}

export default defineConfig({
	plugins: [react(), playgroundMarkerDev()],
	server: {
		cors: true,
		// Vite 生成的绝对 URL 指向本地，避免落到控制台源
		origin: "http://localhost:5173",
		// HMR ws 连回本地，而非 wss://<控制台域>:5173（否则热更新静默失效）
		hmr: { protocol: "ws", host: "localhost", clientPort: 5173 },
		// 同源 /api 转发到 server（:4000），否则命中 SPA fallback 返回 index.html
		proxy: { "/api": "http://localhost:4000" },
	},
	resolve: {
		alias: {
			"@": fileURLToPath(new URL("./src", import.meta.url)),
			// Workspace playbooks package: use source in dev/build (no prebuilt dist needed).
			"@openagentpack/playbooks": `${playbooksSrc}/index.ts`,
			// Workspace SDK subpaths: use source in dev/build when dist/ is not prebuilt.
			"@openagentpack/sdk/session-events": `${sdkSrc}/session-events.ts`,
			"@openagentpack/sdk/scan-lifecycle": `${sdkSrc}/scan-lifecycle.ts`,
			"@openagentpack/sdk/file-lifecycle": `${sdkSrc}/file-lifecycle.ts`,
		},
	},
	build: {
		cssCodeSplit: false,
		rollupOptions: {
			output: {
				// Emit a single, self-contained IIFE bundle (no cross-chunk `import`).
				// The Bailian console injects the entry as a classic <script> (no
				// type="module"), so any top-level ES `import` would throw
				// "Cannot use import statement outside a module" and blank the page.
				format: "iife",
				entryFileNames: "assets/[name].js",
				assetFileNames: "assets/[name].[ext]",
			},
		},
	},
});
