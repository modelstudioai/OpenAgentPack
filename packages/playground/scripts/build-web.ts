import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Build the webui SPA and copy its dist into this package's `web/` so the server can serve it.
const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = join(pkgRoot, "../..");
const webuiDir = join(repoRoot, "apps/webui");
const webuiDist = join(webuiDir, "dist");
const webTarget = join(pkgRoot, "web");

console.log("Building @openagentpack/webui...");
const build = Bun.spawnSync(["bun", "run", "build"], {
	cwd: webuiDir,
	stdio: ["inherit", "inherit", "inherit"],
});
if (build.exitCode !== 0) {
	console.error("webui build failed");
	process.exit(build.exitCode ?? 1);
}

if (!existsSync(webuiDist)) {
	console.error(`Expected webui build output at ${webuiDist}, but it does not exist.`);
	process.exit(1);
}

rmSync(webTarget, { recursive: true, force: true });
cpSync(webuiDist, webTarget, { recursive: true });

const indexPath = join(webTarget, "index.html");
const indexHtml = injectPlaygroundRuntimeMarker(readFileSync(indexPath, "utf8"));
writeFileSync(indexPath, indexHtml);
console.log(`Copied webui build → ${webTarget}`);

function injectPlaygroundRuntimeMarker(html: string): string {
	if (html.includes('name="agents-runtime"')) return html;
	return html.replace("<head>", '<head>\n    <meta name="agents-runtime" content="playground" />');
}
