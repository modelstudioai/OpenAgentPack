import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { jsonError } from "@/lib/http-error";
import { operationsRoute } from "@/routes/operations";
import { projectRoute } from "@/routes/project";
import { projectSessionsRoute } from "@/routes/project-sessions";
import { projectRuntimeManager } from "@/services/project-manager";

export const app = new OpenAPIHono();

// CORS
app.use(
	"/*",
	cors({
		origin: process.env.CORS_ORIGIN?.split(",") ?? ["http://localhost:3000"],
		allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
		allowHeaders: ["Content-Type", "X-Agents-Playground-Token"],
		maxAge: 86400,
	}),
);

app.use("/api/*", async (context, next) => {
	const expected = process.env.AGENTS_PLAYGROUND_TOKEN?.trim();
	const protectsVersionRead =
		context.req.path === "/api/project/versioning" || context.req.path.startsWith("/api/project/versions");
	const requiresToken = protectsVersionRead || !["GET", "HEAD", "OPTIONS"].includes(context.req.method);
	if (expected && requiresToken && context.req.header("X-Agents-Playground-Token") !== expected) {
		return context.json({ error: { message: "Invalid Playground access token." } }, 403);
	}
	await next();
});

// Routes
app.route("/api", projectRoute);
app.route("/api", projectSessionsRoute);
app.route("/api", operationsRoute);

// OpenAPI document
app.doc("/openapi.json", {
	openapi: "3.0.0",
	info: {
		title: "OpenAgentPack API",
		version: "1.0.0",
	},
});

// Health check
app.get("/health", (c) =>
	c.json({
		status: "ok",
		project: { id: projectRuntimeManager.projectId, config_path: projectRuntimeManager.configPath },
	}),
);

// Centralized error formatting: routes throw, this maps to { error: { message } }.
app.onError((error) => jsonError(error));
