import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

// The webui ships as a single self-contained IIFE bundle (see apps/webui/vite.config.ts):
// the Bailian console injects the entry as a classic <script>, so code-splitting into
// ES-module chunks is not an option. Enforce a budget on the *total* JavaScript instead.
const MAX_TOTAL_JAVASCRIPT_BYTES = 1536 * 1024;
const assetsDir = resolve(import.meta.dirname, "../apps/webui/dist/assets");

const jsFiles = readdirSync(assetsDir)
	.filter((file) => file.endsWith(".js"))
	.map((file) => ({ file, bytes: statSync(join(assetsDir, file)).size }));

const totalBytes = jsFiles.reduce((sum, { bytes }) => sum + bytes, 0);

if (totalBytes > MAX_TOTAL_JAVASCRIPT_BYTES) {
	for (const { file, bytes } of jsFiles) {
		console.error(`  ${file}: ${(bytes / 1024).toFixed(1)} KiB`);
	}
	console.error(
		`Total JavaScript ${(totalBytes / 1024).toFixed(1)} KiB exceeds the ${(MAX_TOTAL_JAVASCRIPT_BYTES / 1024).toFixed(
			0,
		)} KiB budget`,
	);
	process.exit(1);
}

console.log(
	`✓ WebUI JavaScript is within the ${(MAX_TOTAL_JAVASCRIPT_BYTES / 1024).toFixed(0)} KiB budget (${(totalBytes / 1024).toFixed(1)} KiB)`,
);
