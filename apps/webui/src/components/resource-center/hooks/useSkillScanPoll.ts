import { classifyFileScan, classifySkillScan, SCAN_FILE_TIMEOUT_MS } from "@openagentpack/sdk/scan-lifecycle";
import { useCallback, useEffect, useState } from "react";
import { getFileStatuses } from "@/lib/domain/file-api";
import type { ResourceCenterView, ResourceSkillRow } from "@/lib/domain/resource-center";
import { createSkillFromFile, getSkillStatuses } from "@/lib/domain/skill-api";
import { withReferencedResources } from "./useResourceCenter";

// UI scan-poll cadence.
const UI_SCAN_POLL_INTERVAL_MS = 2500;

// A skill upload in flight: the zip is uploaded but the skill record doesn't exist yet.
export type PendingSkillUpload = {
	fileId: string;
	filename: string;
	status: "checking" | "creating" | "error";
	error?: string;
	startedAt: number;
};

/**
 * Polls the scan status of still-checking skills so freshly uploaded rows flip to 已生效/已拒绝.
 * Also handles the two-phase upload flow (file audit → create skill).
 */
export function useSkillScanPoll(
	skills: ResourceSkillRow[],
	updateView: (fn: (prev: ResourceCenterView) => ResourceCenterView) => void,
	refresh: () => void,
) {
	const [pendingSkillUploads, setPendingSkillUploads] = useState<PendingSkillUpload[]>([]);

	// Poll existing skill records that are still scanning.
	useEffect(() => {
		const pendingIds = skills.flatMap((s) => (classifySkillScan(s.status) === "pending" ? [s.id] : []));
		if (pendingIds.length === 0) return;
		const timer = setInterval(async () => {
			try {
				const infos = await getSkillStatuses(pendingIds);
				if (infos.length === 0) return;
				const byId = new Map(infos.map((i) => [i.id, i.status]));
				updateView((prev) =>
					withReferencedResources({
						...prev,
						skills: prev.skills.map((s) => {
							const next = byId.get(s.id);
							if (!next || next === s.status) return s;
							return { ...s, status: next, raw: { ...s.raw, status: next } };
						}),
					}),
				);
			} catch {
				// Transient status poll failure — keep the existing rows and retry next tick.
			}
		}, UI_SCAN_POLL_INTERVAL_MS);
		return () => clearInterval(timer);
	}, [skills, updateView]);

	// Two-phase upload: poll each pending upload's FILE status until it clears audit, then create skill.
	useEffect(() => {
		const checking = pendingSkillUploads.filter((p) => p.status === "checking");
		if (checking.length === 0) return;
		const timer = setInterval(async () => {
			const now = Date.now();
			const timedOut = new Set(checking.flatMap((p) => (now - p.startedAt >= SCAN_FILE_TIMEOUT_MS ? [p.fileId] : [])));
			let statusById = new Map<string, string | undefined>();
			try {
				const infos = await getFileStatuses(checking.flatMap((p) => (timedOut.has(p.fileId) ? [] : [p.fileId])));
				statusById = new Map(infos.map((i) => [i.id, i.status]));
			} catch {
				// Transient status poll failure — keep placeholders and retry next tick.
			}
			const toCreate = checking.filter(
				(p) => !timedOut.has(p.fileId) && classifyFileScan(statusById.get(p.fileId)) === "ready",
			);
			setPendingSkillUploads((prev) =>
				prev.map((p) => {
					if (p.status !== "checking") return p;
					if (timedOut.has(p.fileId)) return { ...p, status: "error", error: "审核超时,请稍后重试" };
					const s = statusById.get(p.fileId);
					const phase = classifyFileScan(s);
					if (phase === "ready") return { ...p, status: "creating" };
					if (phase === "failed")
						return { ...p, status: "error", error: s === "type_rejected" ? "文件格式不被接受" : "内容审核未通过" };
					return p;
				}),
			);
			for (const item of toCreate) {
				createSkillFromFile(item.fileId)
					.then(() => {
						setPendingSkillUploads((prev) => prev.filter((p) => p.fileId !== item.fileId));
						refresh();
					})
					.catch((e) => {
						setPendingSkillUploads((prev) =>
							prev.map((p) =>
								p.fileId === item.fileId
									? { ...p, status: "error", error: e instanceof Error ? e.message : "创建 Skill 失败" }
									: p,
							),
						);
					});
			}
		}, UI_SCAN_POLL_INTERVAL_MS);
		return () => clearInterval(timer);
	}, [pendingSkillUploads, refresh]);

	const addPendingUpload = useCallback((upload: PendingSkillUpload) => {
		setPendingSkillUploads((prev) => [...prev, upload]);
	}, []);

	const dismissPendingUpload = useCallback((fileId: string) => {
		setPendingSkillUploads((prev) => prev.filter((p) => p.fileId !== fileId));
	}, []);

	return { pendingSkillUploads, addPendingUpload, dismissPendingUpload };
}
