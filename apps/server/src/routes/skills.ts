import { OpenAPIHono } from "@hono/zod-openapi";
import { jsonError } from "@/lib/http-error";
import {
	createUserSkillFromFile,
	deleteUserSkill,
	getUserSkillStatuses,
	listUserSkills,
	uploadUserSkillFile,
	warmSkillByUrl,
} from "@/services/skills/manage";

export const skillsRoute = new OpenAPIHono();

const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

// POST /api/skills/upload-file — multipart/form-data field `file` (.zip). Phase 1: upload the zip to
// the Files API and return the file record (still `checking`). The webui polls file status, then calls
// POST /api/skills to create the skill once available. Plain handler so multipart stays manual.
skillsRoute.post("/skills/upload-file", async (c) => {
	let body: Record<string, unknown>;
	try {
		body = await c.req.parseBody();
	} catch (error) {
		return jsonError(error, 400);
	}
	const file = body.file;
	if (!(file instanceof File) || file.size === 0) {
		return c.json({ error: { message: "file is required" } }, 400);
	}
	if (!file.name.toLowerCase().endsWith(".zip")) {
		return c.json({ error: { message: "skill file must be a .zip" } }, 400);
	}
	if (file.size > MAX_UPLOAD_BYTES) {
		return c.json({ error: { message: "file too large" } }, 413);
	}
	try {
		const content = new Uint8Array(await file.arrayBuffer());
		const info = await uploadUserSkillFile({ content, filename: file.name });
		return c.json(info, 201);
	} catch (error) {
		return jsonError(error);
	}
});

// POST /api/skills — JSON { fileId } from an already-uploaded, available file. Phase 2: create the
// skill (non-blocking; returns the initial scan status). The webui gates this on file availability.
skillsRoute.post("/skills", async (c) => {
	let body: { fileId?: unknown };
	try {
		body = await c.req.json();
	} catch (error) {
		return jsonError(error, 400);
	}
	const fileId = body.fileId;
	if (typeof fileId !== "string" || fileId.length === 0) {
		return c.json({ error: { message: "fileId is required" } }, 400);
	}
	try {
		const info = await createUserSkillFromFile(fileId);
		return c.json(info, 201);
	} catch (error) {
		return jsonError(error);
	}
});

// POST /api/skills/warm — JSON { name, url }. Pre-provision a seed custom skill (download → upload →
// scan to active) ahead of first click, deduped by the provider-unique name. The slow 3–5 min scan
// happens here, off the user's critical path. Best-effort: the lazy first-click path still covers a
// failure. Returns 200 once the skill is active.
skillsRoute.post("/skills/warm", async (c) => {
	let body: { name?: unknown; url?: unknown };
	try {
		body = await c.req.json();
	} catch (error) {
		return jsonError(error, 400);
	}
	const { name, url } = body;
	if (typeof name !== "string" || !name || typeof url !== "string" || !url) {
		return c.json({ error: { message: "name and url are required" } }, 400);
	}
	try {
		await warmSkillByUrl(name, url);
		return c.json({ ok: true } as const, 200);
	} catch (error) {
		return jsonError(error);
	}
});

// GET /api/skills?source=custom|official — list skills from the chosen catalog (custom =
// workspace-uploaded, default; official = the provider's built-in catalog). Project isolation
// (name prefix) applied by webui.
skillsRoute.get("/skills", async (c) => {
	const source = c.req.query("source");
	if (source !== undefined && source !== "custom" && source !== "official") {
		return c.json({ error: { message: "source must be 'custom' or 'official'" } }, 400);
	}
	try {
		const skills = await listUserSkills(source);
		return c.json({ skills });
	} catch (error) {
		return jsonError(error);
	}
});

// POST /api/skills/status — body { skillIds: string[] } → per-skill scan status for polling.
skillsRoute.post("/skills/status", async (c) => {
	let body: { skillIds?: unknown };
	try {
		body = await c.req.json();
	} catch (error) {
		return jsonError(error, 400);
	}
	const skillIds = body.skillIds;
	if (!Array.isArray(skillIds) || skillIds.some((id) => typeof id !== "string")) {
		return c.json({ error: { message: "skillIds (string[]) is required" } }, 400);
	}
	try {
		const skills = await getUserSkillStatuses(skillIds as string[]);
		return c.json({ skills });
	} catch (error) {
		return jsonError(error);
	}
});

// DELETE /api/skills/:id — remove a custom skill from the provider's Skills API.
skillsRoute.delete("/skills/:id", async (c) => {
	const id = c.req.param("id");
	if (!id) {
		return c.json({ error: { message: "skill id is required" } }, 400);
	}
	try {
		await deleteUserSkill(id);
		return c.body(null, 204);
	} catch (error) {
		return jsonError(error);
	}
});
