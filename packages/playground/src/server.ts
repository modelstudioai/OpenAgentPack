// Apply the @hono/zod-openapi extension (patches zod's prototype with `.openapi()`) before any
// @openagentpack/sdk DTO schema is evaluated. The bundled entry evaluates the sdk barrel first,
// so without this bare import CoreSessionSchema.openapi() races the patch and is undefined at runtime.
import "@hono/zod-openapi";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { app } from "@openagentpack/server/app";
import { Hono } from "hono";
import { resolveListenPort } from "./resolve-port.ts";

export const DEFAULT_PLAYGROUND_PORT = 4848;

// Bundled webui build lives at <package>/web. This file ships to dist/bin/playground.js,
// so the package root is two levels up from the emitted bundle.
const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
const webRoot = join(pkgRoot, "web");
const accessToken = process.env.AGENTS_PLAYGROUND_TOKEN?.trim() ?? "";
const configPath = resolve(process.env.AGENTS_CONFIG_PATH?.trim() || join(process.cwd(), "agents.yaml"));
const projectId = createHash("sha256").update(configPath).digest("hex").slice(0, 16);
const indexHtml = injectPlaygroundRuntimeMarker(readFileSync(join(webRoot, "index.html"), "utf8"), accessToken);

/** Read the playground package version once at startup (works for both source and published dist). */
function readPlaygroundVersion(): string {
	try {
		const manifest = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")) as { version?: string };
		return manifest.version ?? "unknown";
	} catch {
		return "unknown";
	}
}

const playgroundVersion = readPlaygroundVersion();

function injectPlaygroundRuntimeMarker(html: string, token: string): string {
	const escapedToken = token.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
	const markers = [
		...(html.includes('name="agents-runtime"') ? [] : ['<meta name="agents-runtime" content="playground" />']),
		`<meta name="agents-playground-token" content="${escapedToken}" />`,
	].join("\n    ");
	return html.replace("<head>", `<head>\n    ${markers}`);
}

export async function startServer(): Promise<void> {
	const preferred = Number(process.env.PORT ?? DEFAULT_PLAYGROUND_PORT);
	const port = await resolveListenPort(preferred);
	if (port !== preferred) {
		console.log(`Port ${preferred} is in use, using ${port} instead.`);
	}

	const root = new Hono();
	// Playground-enriched health check — registered before the server routes so it takes
	// precedence over the plain { status: "ok" } from apps/server. The `playground` field
	// lets the CLI detect a stale instance on the target port and replace it automatically.
	root.get("/health", (c) =>
		c.json({
			status: "ok",
			playground: { version: playgroundVersion, pid: process.pid, project_id: projectId },
		}),
	);
	// Server routes: /api/*, /openapi.json (merged into the router).
	root.route("/", app);
	// Always serve the injected shell for document routes — static middleware would otherwise
	// return web/index.html without the playground runtime marker.
	root.get("/", (c) => c.html(indexHtml));
	root.get("/index.html", (c) => c.html(indexHtml));
	// Static assets — bust browser caches across playground upgrades. The filenames are
	// stable (`assets/index.js`, not hashed) because the console embed requires predictable
	// paths, so we instruct browsers to revalidate on every navigation.
	root.use("/assets/*", async (c, next) => {
		await next();
		c.header("Cache-Control", "no-cache");
	});
	root.use("/assets/*", serveStatic({ root: webRoot }));
	// SPA fallback: any unmatched GET renders the shell so client routing works on reload.
	root.get("*", (c) => c.html(indexHtml));

	serve({ fetch: root.fetch, port, hostname: "127.0.0.1" }, () => {
		console.log(`OpenAgentPack Playground running at http://localhost:${port}`);
	});
}
