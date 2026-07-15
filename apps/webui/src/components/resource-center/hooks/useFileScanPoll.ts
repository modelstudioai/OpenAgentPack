import { classifyFileScan } from "@openagentpack/sdk/scan-lifecycle";
import { useEffect } from "react";
import { getFileStatuses } from "@/lib/domain/file-api";
import type { ResourceCenterView, ResourceFileRow } from "@/lib/domain/resource-center";

// UI scan-poll cadence. Deliberately tighter than the backend SCAN_POLL_INTERVAL_MS (8s): this is a
// foreground panel where the user is watching rows flip, so snappier feedback beats lighter load.
const UI_SCAN_POLL_INTERVAL_MS = 2500;

/**
 * Polls file scan status until all pending files resolve to available/failed.
 * Updates the view in-place via the provided setter.
 */
export function useFileScanPoll(
	files: ResourceFileRow[],
	updateView: (fn: (prev: ResourceCenterView) => ResourceCenterView) => void,
) {
	useEffect(() => {
		const pendingIds = files.flatMap((f) => (!f.available && classifyFileScan(f.status) !== "failed" ? [f.id] : []));
		if (pendingIds.length === 0) return;
		const timer = setInterval(async () => {
			try {
				const infos = await getFileStatuses(pendingIds);
				if (infos.length === 0) return;
				const byId = new Map(infos.map((i) => [i.id, i]));
				updateView((prev) => ({
					...prev,
					files: prev.files.map((f) => {
						const patch = byId.get(f.id);
						if (!patch) return f;
						const available = patch.available ?? f.available;
						const status = patch.status ?? f.status;
						if (status === f.status && f.available === available) return f;
						return {
							...f,
							status,
							available,
							raw: { ...f.raw, status, available },
						};
					}),
				}));
			} catch {
				// Transient status poll failure — keep the existing rows and retry next tick.
			}
		}, UI_SCAN_POLL_INTERVAL_MS);
		return () => clearInterval(timer);
	}, [files, updateView]);
}
