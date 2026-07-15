import { createContext, type ReactNode, useContext } from "react";
import { useFileScanPoll } from "./hooks/useFileScanPoll";
import { useResourceCenter } from "./hooks/useResourceCenter";
import { type PendingSkillUpload, useSkillScanPoll } from "./hooks/useSkillScanPoll";

// The whole resource-center subtree reads one shared store. Bundling `useResourceCenter` (data +
// per-panel refreshers) with the skill-upload poll into a single context kills the prop-drilling
// that otherwise threads ~18 values through ResourceCenter → panel → section.
type ResourceCenterApi = ReturnType<typeof useResourceCenter>;

interface ResourceCenterContextValue extends ResourceCenterApi {
	pendingSkillUploads: PendingSkillUpload[];
	addPendingUpload: (upload: PendingSkillUpload) => void;
	dismissPendingUpload: (fileId: string) => void;
}

const ResourceCenterContext = createContext<ResourceCenterContextValue | null>(null);

export function ResourceCenterProvider({ children }: { children: ReactNode }) {
	const rc = useResourceCenter();
	// Scan polling lives here (not in a panel) so it keeps running while the user is on any tab.
	useFileScanPoll(rc.view?.files ?? [], rc.updateView);
	const skillPoll = useSkillScanPoll(rc.view?.skills ?? [], rc.updateView, rc.refresh);
	const value: ResourceCenterContextValue = { ...rc, ...skillPoll };
	return <ResourceCenterContext.Provider value={value}>{children}</ResourceCenterContext.Provider>;
}

export function useRc(): ResourceCenterContextValue {
	const ctx = useContext(ResourceCenterContext);
	if (!ctx) throw new Error("useRc 必须在 ResourceCenterProvider 内使用");
	return ctx;
}
