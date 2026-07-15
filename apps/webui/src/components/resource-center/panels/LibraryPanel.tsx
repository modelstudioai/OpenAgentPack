import { FilesSection } from "./library/FilesSection";
import { ReferencedResourcesSection } from "./library/ReferencedResourcesSection";
import { SkillManagementSection } from "./library/SkillManagementSection";

export function LibraryPanel() {
	return (
		<>
			<FilesSection />
			<ReferencedResourcesSection />
			<SkillManagementSection />
		</>
	);
}
