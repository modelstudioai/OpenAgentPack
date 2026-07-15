import { listPlaybooks, resolveSeedPlaybookSkills } from "@openagentpack/playbooks";
import type { CloudEnvironment, CloudVault } from "@openagentpack/sdk";
import { findBaseEnvironment } from "../environment";
import { hasPrefix, stripPrefix, type UploadedFile } from "../file-api";
import type { SkillSummary } from "../skill-api";
import { findBaseVault } from "../vault";
import { toEpoch } from "./shared";
import type { ReferencedSkillRow, ResourceEnvRow, ResourceFileRow, ResourceSkillRow, ResourceVaultRow } from "./types";

// Cloud environment `config` is untyped (z.unknown) and often partial — some envs return only
// `{type:"cloud"}`, others omit packages.npm. Read both fields defensively; never throw on shape.
function readEnvConfig(config: unknown): { networking?: string; packages: string[] } {
	const c = (config ?? {}) as { networking?: { type?: unknown }; packages?: { npm?: unknown } };
	const networking = typeof c.networking?.type === "string" ? c.networking.type : undefined;
	const npm = Array.isArray(c.packages?.npm) ? c.packages.npm.filter((x): x is string => typeof x === "string") : [];
	return { networking, packages: npm };
}

/**
 * Project-scoped environment rows: the resource center only shows what THIS project created,
 * never the org-wide environment list. This project provisions exactly one — the managed base
 * sandbox (name Agents/base + agents.base stamp, via findBaseEnvironment) — so foreign org
 * environments are excluded entirely.
 */
export function deriveEnvironments(environments: CloudEnvironment[]): { rows: ResourceEnvRow[]; baseId?: string } {
	const base = findBaseEnvironment(environments);
	if (!base) return { rows: [], baseId: undefined };
	const cfg = readEnvConfig(base.config);
	const row: ResourceEnvRow = {
		id: base.id,
		name: base.name ?? "",
		description: base.description ?? undefined,
		isBase: true,
		networking: cfg.networking,
		packages: cfg.packages,
		version: base.version,
		scope: base.scope,
		createdAt: base.created_at,
		updatedAt: base.updated_at,
		raw: base,
	};
	return { rows: [row], baseId: base.id };
}

/**
 * Project-scoped vault rows: mirrors deriveEnvironments. This project provisions exactly one —
 * the managed base vault (display_name Agents/secrets + agents.vault stamp, via findBaseVault)
 * holding the DASHSCOPE_API_KEY (server-injected) — so foreign org vaults are excluded entirely.
 */
export function deriveVaults(vaults: CloudVault[]): { rows: ResourceVaultRow[]; baseVaultId?: string } {
	const base = findBaseVault(vaults);
	if (!base) return { rows: [], baseVaultId: undefined };
	const row: ResourceVaultRow = {
		id: base.id,
		name: base.display_name ?? "",
		createdAt: base.created_at ?? undefined,
		updatedAt: base.updated_at ?? undefined,
		raw: base,
	};
	return { rows: [row], baseVaultId: base.id };
}

/**
 * Project-scoped file rows, newest first. Files carry no server-side project metadata, so ownership
 * rides on the Agents__ filename prefix (see file-api). We filter to prefixed files defensively (the
 * domain `listFiles` already does, but `deriveResourceCenter` may be fed a raw page) and strip the
 * prefix for display so the user only ever sees their original filename.
 */
export function deriveFiles(files: UploadedFile[]): ResourceFileRow[] {
	return files
		.flatMap((f) =>
			hasPrefix(f.filename)
				? [
						{
							id: f.id,
							name: stripPrefix(f.filename),
							filename: f.filename,
							mimeType: f.mime_type,
							sizeBytes: f.size_bytes,
							status: f.status,
							available: f.available,
							createdAt: f.created_at,
							raw: f,
						},
					]
				: [],
		)
		.sort((a, b) => toEpoch(b.createdAt) - toEpoch(a.createdAt));
}

/**
 * Workspace custom skill rows, newest first. Skills are workspace-level custom resources (no project
 * prefix): Bailian derives a skill's name from its SKILL.md manifest, not the uploaded zip filename,
 * so there is nothing to strip. We just drop any tombstoned (`deleted`) rows and sort newest-first.
 */
export function deriveSkills(skills: SkillSummary[]): ResourceSkillRow[] {
	return skills
		.flatMap((s) =>
			s.status === "deleted"
				? []
				: [
						{
							id: s.id,
							name: s.name,
							source: s.source,
							status: s.status,
							latestVersion: s.latest_version,
							createdAt: s.created_at,
							updatedAt: s.updated_at,
							raw: s,
						},
					],
		)
		.sort((a, b) => toEpoch(b.createdAt) - toEpoch(a.createdAt));
}

/**
 * Current-playbook skill references joined against the provider catalogs. Custom skills use the
 * provider-unique `name` as their natural key; official skills use their stable provider code/id.
 * This answers "what this WebUI app depends on", not "what this app owns".
 */
export function deriveReferencedSkills(
	customSkills: SkillSummary[],
	officialSkills: SkillSummary[] = [],
): ReferencedSkillRow[] {
	const customByName = new Map(customSkills.map((skill) => [skill.name, skill]));
	const officialByIdOrName = new Map<string, SkillSummary>();
	for (const skill of officialSkills) {
		officialByIdOrName.set(skill.id, skill);
		officialByIdOrName.set(skill.name, skill);
	}

	const rows = new Map<string, ReferencedSkillRow>();
	for (const playbook of listPlaybooks()) {
		for (const skill of resolveSeedPlaybookSkills(playbook.id)) {
			const name = skill.name ?? skill.skillId;
			const key = `${skill.type}:${name}`;
			const existing = rows.get(key);
			if (existing) {
				existing.declaredBy.push(playbook.id);
				continue;
			}

			const provider = skill.type === "custom" ? customByName.get(name) : officialByIdOrName.get(skill.skillId);
			rows.set(key, {
				key,
				name,
				type: skill.type,
				declaredBy: [playbook.id],
				status: provider?.status ?? (skill.type === "official" ? "declared" : "missing"),
				providerCode: provider?.id,
				latestVersion: provider?.latest_version ?? skill.version,
				url: skill.url,
				raw: provider,
			});
		}
	}

	return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
}
