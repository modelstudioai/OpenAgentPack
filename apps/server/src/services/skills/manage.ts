import {
	createSkillFromFileId,
	deleteSkill,
	getAgent,
	getFileInfo,
	getSkillInfo,
	listSkills,
	type ProviderFileInfo,
	type ProviderSkillInfo,
	uploadFile,
} from "@openagentpack/sdk";
import {
	classifyFileScan,
	classifySkillScan,
	pollUntil,
	SCAN_FILE_TIMEOUT_MS,
	SCAN_POLL_INTERVAL_MS,
	SCAN_SKILL_TIMEOUT_MS,
} from "@openagentpack/sdk/scan-lifecycle";
import { DEFAULT_AGENT_ID } from "@/services/agents/catalog";
import { uploadUserFile } from "@/services/files/upload";
import { withAgentRuntime } from "@/services/runtime-factory";

/**
 * Phase 1 of skill upload: push the zip bytes to the Files API and return the file record (still
 * `checking` while content audit runs). The webui polls file status and calls createUserSkillFromFile
 * once `available`. Split from creation so the upload never blocks on the audit (was a 120s server-side
 * wait that left the UI stuck "上传中").
 */
export async function uploadUserSkillFile(input: { content: Uint8Array; filename: string }): Promise<ProviderFileInfo> {
	return uploadUserFile({
		content: input.content,
		filename: input.filename,
		// /skills validates the uploaded file's mime_type and only accepts application/octet-stream;
		// application/zip fails with SKILL_FILE_NOT_FOUND (see bailian adapter uploadSkillZip).
		mimeType: "application/octet-stream",
	});
}

/**
 * Phase 2 of skill upload: create the skill record from an already-uploaded, available file. Caller
 * (the webui) must ensure the file cleared audit first. Non-blocking: returns the initial (usually
 * `checking`) skill status; the webui polls skill statuses to active.
 */
export async function createUserSkillFromFile(fileId: string): Promise<ProviderSkillInfo> {
	return withAgentRuntime(DEFAULT_AGENT_ID, async (ctx, compiled) => {
		const provider = getAgent(ctx, compiled.agentId).provider;
		return createSkillFromFileId(ctx, fileId, { provider });
	});
}

export async function listUserSkills(source: "custom" | "official" = "custom"): Promise<ProviderSkillInfo[]> {
	return withAgentRuntime(DEFAULT_AGENT_ID, async (ctx, compiled) => {
		const provider = getAgent(ctx, compiled.agentId).provider;
		return listSkills(ctx, { provider, source });
	});
}

export async function getUserSkillStatuses(
	skillIds: string[],
): Promise<{ id: string; status?: ProviderSkillInfo["status"] }[]> {
	return withAgentRuntime(DEFAULT_AGENT_ID, async (ctx, compiled) => {
		const provider = getAgent(ctx, compiled.agentId).provider;
		return Promise.all(
			skillIds.map(async (id) => {
				try {
					const info = await getSkillInfo(ctx, id, { provider });
					return { id, status: info.status };
				} catch {
					return { id, status: undefined };
				}
			}),
		);
	});
}

export async function deleteUserSkill(id: string): Promise<void> {
	return withAgentRuntime(DEFAULT_AGENT_ID, async (ctx, compiled) => {
		const provider = getAgent(ctx, compiled.agentId).provider;
		await deleteSkill(ctx, id, { provider });
	});
}

// Warm polling: the custom-skill security scan runs 3–5 min on the production workspace, so poll
// gently (one provider call every SCAN_POLL_INTERVAL_MS) to keep load light — warming is off the
// user's critical path, so cadence matters more than latency. Timeouts and cadence come from the
// shared scan-lifecycle module so they cannot drift.

/**
 * Pre-provision a seed-declared custom skill (name + downloadable url) ahead of first click: dedupe
 * by the provider-unique name and, if absent, download → upload → wait for content audit → create the
 * skill → wait for the security scan to reach `active`. The slow 3–5 min scan happens here, off the
 * user's first-click path. Idempotent: an already-`active` skill of the same name returns immediately;
 * a `checking` one just waits; a `rejected` one is terminal.
 */
export async function warmSkillByUrl(name: string, url: string): Promise<void> {
	await withAgentRuntime(DEFAULT_AGENT_ID, async (ctx, compiled) => {
		const provider = getAgent(ctx, compiled.agentId).provider;

		// Name is the dedupe key (the provider derives it from the archive manifest and enforces
		// uniqueness), so a match means "already uploaded": reuse it instead of re-downloading.
		const existing = (await listSkills(ctx, { provider, source: "custom" })).find(
			(skill: ProviderSkillInfo) => skill.name === name,
		);
		if (existing?.status === "active") return;
		if (existing?.status === "rejected") throw new Error(`自定义 Skill「${name}」此前扫描未通过，请修正后更新版本`);
		let skillId = existing && existing.status !== "deleted" ? existing.id : undefined;

		if (!skillId) {
			const res = await fetch(url);
			if (!res.ok) throw new Error(`自定义 Skill 下载失败：${res.status} ${url}`);
			const content = new Uint8Array(await res.arrayBuffer());
			// /skills only accepts application/octet-stream (see uploadUserSkillFile).
			const file = await uploadFile(ctx, content, `${name}.zip`, { provider, mimeType: "application/octet-stream" });
			await pollUntil<ProviderFileInfo>({
				poll: () => getFileInfo(ctx, file.id, { provider }),
				classify: (info) => classifyFileScan(info.status),
				timeoutMs: SCAN_FILE_TIMEOUT_MS,
				interval: SCAN_POLL_INTERVAL_MS,
				onFailed: (info) => new Error(`自定义 Skill「${name}」文件审核未通过（${info.status}）`),
				onTimeout: () => new Error(`自定义 Skill「${name}」文件审核超时`),
			});
			const skill = await createSkillFromFileId(ctx, file.id, { provider });
			skillId = skill.id;
		}

		const resolvedSkillId = skillId;
		await pollUntil<ProviderSkillInfo>({
			poll: () => getSkillInfo(ctx, resolvedSkillId, { provider }),
			classify: (info) => classifySkillScan(info.status),
			timeoutMs: SCAN_SKILL_TIMEOUT_MS,
			interval: SCAN_POLL_INTERVAL_MS,
			onFailed: () => new Error(`自定义 Skill「${name}」扫描未通过`),
			onTimeout: () => new Error(`自定义 Skill「${name}」扫描超时`),
		});
	});
}
