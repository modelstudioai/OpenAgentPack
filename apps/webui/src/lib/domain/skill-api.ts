import {
	createApiSkillFromFile,
	deleteApiSkill,
	getApiSkillStatuses,
	listApiSkills,
	type SkillStatusInfo,
	type SkillSummary,
	type SkillUploadResult,
	uploadApiSkill,
} from "../api/client";
import { formatApiErrorMessage } from "../api/error-message";

export type { SkillStatusInfo, SkillSummary, SkillUploadResult };

/**
 * Upload a skill zip. The file is uploaded but still under content audit, so the caller must
 * poll file status then call createSkillFromFile to create the skill record (phase 2).
 */
export async function uploadSkill(file: File): Promise<SkillUploadResult> {
	const { data, error } = await uploadApiSkill({ body: { file } });
	if (error) throw new Error(formatApiErrorMessage(error, "上传失败"));
	if (!data) throw new Error("上传失败");
	return data;
}

/** Phase 2: create the skill record from an uploaded, now-available file. */
export async function createSkillFromFile(fileId: string): Promise<SkillSummary> {
	const { data, error } = await createApiSkillFromFile({ body: { fileId } });
	if (error) throw new Error(formatApiErrorMessage(error, "创建 Skill 失败"));
	if (!data) throw new Error("创建 Skill 失败");
	return data;
}

/** List the project's custom skills (workspace-level, newest first). */
export async function listSkills(): Promise<SkillSummary[]> {
	const { data, error } = await listApiSkills({ query: { source: "custom" } });
	if (error) throw new Error(formatApiErrorMessage(error, "获取 Skill 列表失败"));
	return (data?.skills ?? []).filter((s) => s.source === "custom");
}

/** List the provider's built-in (official) skill catalog. Read-only — these can't be uploaded or deleted. */
export async function listOfficialSkills(): Promise<SkillSummary[]> {
	const { data, error } = await listApiSkills({ query: { source: "official" } });
	if (error) throw new Error(formatApiErrorMessage(error, "获取内置 Skill 列表失败"));
	return (data?.skills ?? []).filter((s) => s.source === "official");
}

/** Delete a custom skill by id through the active transport. */
export async function deleteSkill(skillId: string): Promise<void> {
	const { error } = await deleteApiSkill({ path: { skillId } });
	if (error) throw new Error(formatApiErrorMessage(error, "删除失败"));
}

/** Poll scan status for a batch of skills (checking → active/rejected). */
export async function getSkillStatuses(skillIds: string[]): Promise<SkillStatusInfo[]> {
	if (skillIds.length === 0) return [];
	const { data, error } = await getApiSkillStatuses({ body: { skillIds } });
	if (error) throw new Error(formatApiErrorMessage(error, "查询 Skill 状态失败"));
	return data?.skills ?? [];
}
