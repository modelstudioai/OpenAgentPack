import type { ProjectVersionPreview } from "@/lib/project-api";
import { buildYamlLineDiff } from "@/resources/yaml-diff";

type VersionFileChange = ProjectVersionPreview["changes"][number];

export function SourceFileDiff({
	change,
	version,
	direction,
}: {
	change: VersionFileChange;
	version: string;
	direction: "restore" | "working-tree";
}) {
	const showingWorkingChanges = direction === "working-tree";
	const before = showingWorkingChanges ? change.after : change.before;
	const after = showingWorkingChanges ? change.before : change.after;
	const beforeMissing = change.change === (showingWorkingChanges ? "delete" : "create");
	const afterMissing = change.change === (showingWorkingChanges ? "create" : "delete");
	const displayedChange = showingWorkingChanges
		? change.change === "create"
			? "delete"
			: change.change === "delete"
				? "create"
				: "update"
		: change.change;
	const diff = buildYamlLineDiff(before ?? "", after ?? "");
	return (
		<div className="yaml-unified-diff version-yaml-diff">
			<div className="yaml-diff-file-header">
				<span>
					--- {beforeMissing ? "/dev/null" : `${showingWorkingChanges ? version : "working tree"}/${change.path}`}
				</span>
				<span>
					+++ {afterMissing ? "/dev/null" : `${showingWorkingChanges ? "working tree" : version}/${change.path}`}
				</span>
			</div>
			{change.binary ? (
				<div className="yaml-diff-hunk">Binary file {displayedChange}</div>
			) : (
				<>
					<div className="yaml-diff-hunk">
						@@ -1,{diff.beforeLineCount} +1,{diff.afterLineCount} @@
					</div>
					<div className="yaml-diff-lines">
						{diff.lines.map((line) => (
							<div
								className={`yaml-diff-line ${line.kind}`}
								key={`${line.kind}:${line.beforeLine ?? "new"}:${line.afterLine ?? "old"}:${line.text}`}
							>
								<span className="yaml-diff-line-number">{line.beforeLine ?? ""}</span>
								<span className="yaml-diff-line-number">{line.afterLine ?? ""}</span>
								<span className="yaml-diff-marker">
									{line.kind === "addition" ? "+" : line.kind === "deletion" ? "-" : " "}
								</span>
								<code>{line.text || " "}</code>
							</div>
						))}
					</div>
				</>
			)}
		</div>
	);
}
