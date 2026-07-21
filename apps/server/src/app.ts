import { OpenAPIHono } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { jsonError } from "@/lib/http-error";
import { agentsRoute } from "@/routes/agents";
import { configRoute } from "@/routes/config";
import { deploymentsRoute } from "@/routes/deployments";
import { environmentsRoute } from "@/routes/environments";
import { filesRoute } from "@/routes/files";
import { modelsRoute } from "@/routes/models";
import { sessionsRoute } from "@/routes/sessions";
import { skillsRoute } from "@/routes/skills";
import { vaultsRoute } from "@/routes/vaults";

export const app = new OpenAPIHono();

// CORS
app.use(
	"/*",
	cors({
		origin: process.env.CORS_ORIGIN?.split(",") ?? ["http://localhost:3000"],
		allowMethods: ["GET", "POST", "PUT", "OPTIONS"],
		allowHeaders: ["Content-Type"],
		maxAge: 86400,
	}),
);

// Routes
app.route("/api", configRoute);
app.route("/api", deploymentsRoute);
app.route("/api", agentsRoute);
app.route("/api", environmentsRoute);
app.route("/api", vaultsRoute);
app.route("/api", sessionsRoute);
app.route("/api", filesRoute);
app.route("/api", skillsRoute);
app.route("/api", modelsRoute);

// OpenAPI document
app.doc("/openapi.json", {
	openapi: "3.0.0",
	info: {
		title: "OpenAgentPack API",
		version: "1.0.0",
	},
});

// Health check
app.get("/health", (c) => c.json({ status: "ok" }));

// Centralized error formatting: routes throw, this maps to { error: { message } }.
app.onError((error) => jsonError(error));
