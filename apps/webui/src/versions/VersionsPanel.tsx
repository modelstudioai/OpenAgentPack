import {
	AlertTriangle,
	CheckCircle2,
	GitBranch,
	GitCommit,
	History,
	LoaderCircle,
	Power,
	RotateCcw,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	initializeProjectGit,
	listProjectVersions,
	type ProjectGitStatus,
	type ProjectVersion,
	type ProjectVersionPreview,
	previewProjectVersion,
	restoreProjectVersion,
	setProjectGitVersioning,
} from "@/lib/project-api";
import { buildYamlLineDiff } from "@/resources/yaml-diff";

interface VersionsPanelProps {
	projectRevision?: string;
	git?: ProjectGitStatus;
	gitLoading: boolean;
	gitError?: string;
	writeBlockedReason?: string;
	onGitChange(status: ProjectGitStatus): void;
	onRestored(): Promise<void>;
}

export function VersionsPanel({
	projectRevision,
	git,
	gitLoading,
	gitError,
	writeBlockedReason,
	onGitChange,
	onRestored,
}: VersionsPanelProps) {
	const [versions, setVersions] = useState<ProjectVersion[]>([]);
	const [nextCursor, setNextCursor] = useState<string | null>(null);
	const [selected, setSelected] = useState<ProjectVersion>();
	const [preview, setPreview] = useState<ProjectVersionPreview>();
	const [historyBusy, setHistoryBusy] = useState(false);
	const [writeBusy, setWriteBusy] = useState(false);
	const [previewBusy, setPreviewBusy] = useState(false);
	const [localError, setLocalError] = useState<string>();
	const previewRequestGenerationRef = useRef(0);
	const latestProjectRevisionRef = useRef(projectRevision);
	const repositoryRoot = git?.repository_root;
	const currentHead = git?.head;
	const previewIsCurrent =
		preview?.base_revision === projectRevision &&
		preview?.base_head === currentHead &&
		preview?.commit === selected?.commit;

	const loadVersions = useCallback(
		async (cursor?: string) => {
			if (!repositoryRoot) {
				setVersions([]);
				setNextCursor(null);
				return;
			}
			setHistoryBusy(true);
			try {
				const page = await listProjectVersions(cursor);
				setVersions((current) => (cursor ? [...current, ...page.versions] : page.versions));
				setNextCursor(page.next_cursor);
				setLocalError(undefined);
			} catch (error) {
				setLocalError(errorMessage(error));
			} finally {
				setHistoryBusy(false);
			}
		},
		[repositoryRoot],
	);

	useEffect(() => {
		previewRequestGenerationRef.current += 1;
		setSelected(undefined);
		setPreview(undefined);
		setPreviewBusy(false);
		if (currentHead !== undefined) void loadVersions();
	}, [currentHead, loadVersions]);

	useEffect(() => {
		if (latestProjectRevisionRef.current === projectRevision) return;
		latestProjectRevisionRef.current = projectRevision;
		previewRequestGenerationRef.current += 1;
		setSelected(undefined);
		setPreview(undefined);
		setPreviewBusy(false);
	}, [projectRevision]);

	const handleInitialize = async () => {
		if (!projectRevision) return;
		setWriteBusy(true);
		setLocalError(undefined);
		try {
			onGitChange(await initializeProjectGit(projectRevision));
		} catch (error) {
			setLocalError(errorMessage(error));
		} finally {
			setWriteBusy(false);
		}
	};

	const handleSelect = async (version: ProjectVersion) => {
		const requestGeneration = ++previewRequestGenerationRef.current;
		setSelected(version);
		setPreview(undefined);
		setLocalError(undefined);
		if (!projectRevision || !git?.head) return;
		setPreviewBusy(true);
		try {
			const nextPreview = await previewProjectVersion(version.commit, projectRevision, git.head);
			if (requestGeneration !== previewRequestGenerationRef.current) return;
			setPreview(nextPreview);
		} catch (error) {
			if (requestGeneration !== previewRequestGenerationRef.current) return;
			setLocalError(errorMessage(error));
		} finally {
			if (requestGeneration === previewRequestGenerationRef.current) setPreviewBusy(false);
		}
	};

	const handleVersioningToggle = async () => {
		if (!projectRevision || !git?.repository_root) return;
		setWriteBusy(true);
		setLocalError(undefined);
		try {
			onGitChange(await setProjectGitVersioning(projectRevision, !git.enabled));
		} catch (error) {
			setLocalError(errorMessage(error));
		} finally {
			setWriteBusy(false);
		}
	};

	const handleRestore = async () => {
		if (!selected || !preview?.can_restore || !previewIsCurrent) return;
		if (
			!window.confirm(
				`Restore agents.yaml from ${preview.commit.slice(0, 12)} to the working tree? HEAD will not move.`,
			)
		) {
			return;
		}
		setWriteBusy(true);
		setLocalError(undefined);
		try {
			await restoreProjectVersion(preview.commit, preview.base_revision, preview.base_head);
			await onRestored();
		} catch (error) {
			setLocalError(errorMessage(error));
		} finally {
			setWriteBusy(false);
		}
	};

	if (gitLoading && !git) {
		return (
			<div className="empty-panel content-empty-panel">
				<LoaderCircle className="spin" />
				<p>Inspecting local Git history…</p>
			</div>
		);
	}

	return (
		<section className="versions-panel panel-stack">
			<div className="action-toolbar">
				<div>
					<h2>Local configuration versions</h2>
					<p>
						Workbench and CLI share one local versioning switch. When enabled, successful Apply commits agents.yaml;
						Workbench never pushes or switches branches.
					</p>
				</div>
			</div>

			{(gitError || localError) && <VersionNotice tone="error">{localError ?? gitError}</VersionNotice>}
			{writeBlockedReason && <VersionNotice tone="warning">{writeBlockedReason}</VersionNotice>}

			{!git?.git_available ? (
				<VersionNotice tone="error">Git is not installed or is not available on PATH.</VersionNotice>
			) : !git.repository_root ? (
				<div className="version-empty-card">
					<GitBranch />
					<div>
						<h3>No local Git repository</h3>
						<p>Automatic initialization did not complete. Retry to create main and commit agents.yaml.</p>
					</div>
					<button
						type="button"
						className="primary-button"
						disabled={!projectRevision || Boolean(writeBlockedReason) || writeBusy}
						onClick={() => void handleInitialize()}
					>
						{writeBusy ? <LoaderCircle className="spin" /> : <GitBranch />} Retry Initialization
					</button>
				</div>
			) : (
				<>
					<div className="git-summary-grid">
						<GitSummary label="Repository" value={git.repository_root} />
						<GitSummary label="Branch" value={git.branch ?? "detached HEAD"} />
						<GitSummary label="HEAD" value={git.head?.slice(0, 12) ?? "no commits"} mono />
						<GitSummary
							label="agents.yaml"
							value={git.config_versioned ? "versioned" : git.config_status}
							tone={git.config_versioned ? "good" : "warn"}
						/>
						<GitSummary
							label="Automatic versions"
							value={git.enabled ? "enabled" : "disabled"}
							tone={git.enabled ? "good" : "warn"}
						/>
					</div>

					<div className="action-toolbar version-toggle-toolbar">
						<div>
							<strong>Shared CLI and Workbench switch</strong>
							<p>
								{git.enabled ? "Successful Apply creates a local version." : "Apply will not create a local version."}
							</p>
						</div>
						<button
							type="button"
							className="secondary-button"
							disabled={!projectRevision || Boolean(writeBlockedReason) || writeBusy}
							onClick={() => void handleVersioningToggle()}
						>
							{writeBusy ? <LoaderCircle className="spin" /> : <Power />} {git.enabled ? "Disable" : "Enable"}
						</button>
					</div>

					{[...new Set([...git.commit_blockers, ...git.restore_blockers])].map((blocker) => (
						<VersionNotice key={blocker} tone="warning">
							{blocker}
						</VersionNotice>
					))}

					<div className="version-browser">
						<div className="version-list-card">
							<header>
								<History />
								<strong>Current branch history</strong>
							</header>
							<div className="version-list">
								{versions.map((version) => (
									<button
										type="button"
										className={selected?.commit === version.commit ? "active" : ""}
										key={version.commit}
										onClick={() => void handleSelect(version)}
									>
										<code>{version.short_commit}</code>
										<span>
											<strong>{version.message}</strong>
											<small>
												{version.author_name} · {new Date(version.authored_at).toLocaleString()}
											</small>
										</span>
									</button>
								))}
								{versions.length === 0 && !historyBusy && <p>No versions have been created for agents.yaml.</p>}
							</div>
							{nextCursor && (
								<button
									type="button"
									className="secondary-button version-load-more"
									disabled={historyBusy}
									onClick={() => void loadVersions(nextCursor)}
								>
									{historyBusy ? <LoaderCircle className="spin" /> : <History />} Load more
								</button>
							)}
						</div>

						<div className="version-preview-card">
							{previewBusy ? (
								<div className="version-preview-empty">
									<LoaderCircle className="spin" />
									<p>Validating historical agents.yaml…</p>
								</div>
							) : preview && selected && previewIsCurrent ? (
								<VersionPreview
									version={selected}
									preview={preview}
									writeBlockedReason={writeBlockedReason}
									busy={writeBusy}
									onRestore={handleRestore}
								/>
							) : (
								<div className="version-preview-empty">
									<GitCommit />
									<p>Select a version to preview its redacted working-tree restore.</p>
								</div>
							)}
						</div>
					</div>
				</>
			)}
		</section>
	);
}

function VersionPreview({
	version,
	preview,
	writeBlockedReason,
	busy,
	onRestore,
}: {
	version: ProjectVersion;
	preview: ProjectVersionPreview;
	writeBlockedReason?: string;
	busy: boolean;
	onRestore(): Promise<void>;
}) {
	const diff = buildYamlLineDiff(preview.before_yaml, preview.after_yaml);
	return (
		<>
			<header className="version-preview-heading">
				<div>
					<strong>{version.message}</strong>
					<code>{version.commit}</code>
				</div>
				<button
					type="button"
					className="danger-button"
					disabled={!preview.can_restore || busy || Boolean(writeBlockedReason)}
					onClick={() => void onRestore()}
				>
					{busy ? <LoaderCircle className="spin" /> : <RotateCcw />} Restore to working tree
				</button>
			</header>
			<div className="yaml-unified-diff version-yaml-diff">
				<div className="yaml-diff-file-header">
					<span>--- working tree</span>
					<span>+++ {version.short_commit}</span>
				</div>
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
			</div>
			<div className={`commit-readiness ${preview.can_restore ? "ready" : "blocked"}`}>
				{preview.can_restore ? <CheckCircle2 /> : <AlertTriangle />}
				<span>{preview.can_restore ? "Ready to restore to the working tree" : "Restore blocked"}</span>
			</div>
			{preview.blockers.map((blocker) => (
				<VersionNotice key={blocker} tone="warning">
					{blocker}
				</VersionNotice>
			))}
			{preview.diagnostics.map((diagnostic) => (
				<div className={`preview-diagnostic ${diagnostic.severity}`} key={`${diagnostic.code}:${diagnostic.message}`}>
					<strong>{diagnostic.code}</strong>
					<span>{diagnostic.message}</span>
				</div>
			))}
		</>
	);
}

function GitSummary({
	label,
	value,
	mono,
	tone,
}: {
	label: string;
	value: string;
	mono?: boolean;
	tone?: "good" | "warn";
}) {
	return (
		<div className={`git-summary-item ${tone ?? ""}`}>
			<span>{label}</span>
			{mono ? <code>{value}</code> : <strong title={value}>{value}</strong>}
		</div>
	);
}

function VersionNotice({ children, tone }: { children: React.ReactNode; tone: "warning" | "error" }) {
	return (
		<div className={`version-notice ${tone}`}>
			<AlertTriangle />
			<span>{children}</span>
		</div>
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
