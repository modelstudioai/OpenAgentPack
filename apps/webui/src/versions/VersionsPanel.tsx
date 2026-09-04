import { AlertTriangle, CheckCircle2, History, LoaderCircle, Power, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	listProjectVersions,
	type ProjectVersion,
	type ProjectVersioningStatus,
	type ProjectVersionPreview,
	previewProjectVersion,
	restoreProjectVersion,
	setProjectVersioning,
} from "@/lib/project-api";
import { SourceFileDiff } from "@/versions/SourceFileDiff";

interface VersionsPanelProps {
	projectRevision?: string;
	versioning?: ProjectVersioningStatus;
	versioningLoading: boolean;
	versioningError?: string;
	writeBlockedReason?: string;
	onVersioningChange(status: ProjectVersioningStatus): void;
	onRestored(): Promise<void>;
}

export function VersionsPanel({
	projectRevision,
	versioning,
	versioningLoading,
	versioningError,
	writeBlockedReason,
	onVersioningChange,
	onRestored,
}: VersionsPanelProps) {
	const { i18n, t } = useTranslation();
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
	const initialized = versioning?.initialized ?? false;
	const currentVersion = versioning?.head_version;
	const previewIsCurrent =
		preview?.base_revision === projectRevision &&
		preview?.base_head_version === currentVersion &&
		preview?.version_id === selected?.version_id;

	const loadVersions = useCallback(
		async (cursor?: string) => {
			if (!initialized) {
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
		[initialized],
	);

	useEffect(() => {
		previewRequestGenerationRef.current += 1;
		setSelected(undefined);
		setPreview(undefined);
		setPreviewBusy(false);
		if (currentVersion !== undefined) void loadVersions();
	}, [currentVersion, loadVersions]);

	useEffect(() => {
		if (latestProjectRevisionRef.current === projectRevision) return;
		latestProjectRevisionRef.current = projectRevision;
		previewRequestGenerationRef.current += 1;
		setSelected(undefined);
		setPreview(undefined);
		setPreviewBusy(false);
	}, [projectRevision]);

	const handleSelect = async (version: ProjectVersion) => {
		const requestGeneration = ++previewRequestGenerationRef.current;
		setSelected(version);
		setPreview(undefined);
		setLocalError(undefined);
		if (!projectRevision || !versioning?.head_version) return;
		setPreviewBusy(true);
		try {
			const nextPreview = await previewProjectVersion(version.version_id, projectRevision, versioning.head_version);
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
		if (!projectRevision || !versioning) return;
		setWriteBusy(true);
		setLocalError(undefined);
		try {
			onVersioningChange(await setProjectVersioning(projectRevision, !versioning.enabled));
		} catch (error) {
			setLocalError(errorMessage(error));
		} finally {
			setWriteBusy(false);
		}
	};

	const handleRestore = async () => {
		if (!selected || !preview?.can_restore || !previewIsCurrent) return;
		if (selected.version_id === versioning?.head_version) return;
		if (!window.confirm(t("versions.confirmRestore", { version: preview.version_id.slice(0, 12) }))) {
			return;
		}
		setWriteBusy(true);
		setLocalError(undefined);
		try {
			await restoreProjectVersion(preview.version_id, preview.base_revision, preview.base_head_version);
			await onRestored();
		} catch (error) {
			setLocalError(errorMessage(error));
		} finally {
			setWriteBusy(false);
		}
	};

	if (versioningLoading && !versioning) {
		return (
			<div className="empty-panel content-empty-panel">
				<LoaderCircle className="spin" />
				<p>{t("versions.loading")}</p>
			</div>
		);
	}

	return (
		<section className="versions-panel panel-stack">
			<div className="action-toolbar">
				<div>
					<h2>{t("versions.title")}</h2>
					<p>{t("versions.description")}</p>
				</div>
			</div>

			{(versioningError || localError) && <VersionNotice tone="error">{localError ?? versioningError}</VersionNotice>}
			{writeBlockedReason && <VersionNotice tone="warning">{writeBlockedReason}</VersionNotice>}

			{!initialized ? (
				<div className="version-empty-card">
					<History />
					<div>
						<h3>{t("versions.notEnabled")}</h3>
						<p>{t("versions.enableBaseline")}</p>
					</div>
					<button
						type="button"
						className="primary-button"
						disabled={!projectRevision || Boolean(writeBlockedReason) || writeBusy}
						onClick={() => void handleVersioningToggle()}
					>
						{writeBusy ? <LoaderCircle className="spin" /> : <Power />} {t("versions.enableLocalVersions")}
					</button>
				</div>
			) : versioning ? (
				<>
					<div className="version-summary-grid">
						<VersionSummary label={t("versions.store")} value={versioning.store_root} />
						<VersionSummary
							label={t("versions.currentVersion")}
							value={versioning.head_version?.slice(0, 12) ?? t("versions.noVersions")}
							mono
						/>
						<VersionSummary
							label={t("versions.projectSource")}
							value={
								versioning.source_versioned
									? t("versions.versioned")
									: t(`versions.${versioning.source_status}`, { defaultValue: versioning.source_status })
							}
							tone={versioning.source_versioned ? "good" : "warn"}
						/>
						<VersionSummary
							label={t("versions.automaticVersions")}
							value={versioning.enabled ? t("versions.enabled") : t("versions.disabled")}
							tone={versioning.enabled ? "good" : "warn"}
						/>
					</div>

					<div className="action-toolbar version-toggle-toolbar">
						<div>
							<strong>{t("versions.sharedSwitch")}</strong>
							<p>{versioning.enabled ? t("versions.publishCreates") : t("versions.publishNoSnapshot")}</p>
						</div>
						<button
							type="button"
							className="secondary-button"
							disabled={!projectRevision || Boolean(writeBlockedReason) || writeBusy}
							onClick={() => void handleVersioningToggle()}
						>
							{writeBusy ? <LoaderCircle className="spin" /> : <Power />}{" "}
							{versioning.enabled ? t("common.disable") : t("common.enable")}
						</button>
					</div>

					{[...new Set([...versioning.write_blockers, ...versioning.restore_blockers])].map((blocker) => (
						<VersionNotice key={blocker} tone="warning">
							{blocker}
						</VersionNotice>
					))}

					<div className="version-browser">
						<div className="version-list-card">
							<header>
								<History />
								<strong>{t("versions.history")}</strong>
							</header>
							<div className="version-list">
								{versions.map((version) => (
									<button
										type="button"
										className={selected?.version_id === version.version_id ? "active" : ""}
										key={version.version_id}
										onClick={() => void handleSelect(version)}
									>
										<code>{version.short_version}</code>
										<span>
											<strong>{version.message}</strong>
											<small>
												{version.created_by} · {new Date(version.created_at).toLocaleString(i18n.resolvedLanguage)}
											</small>
										</span>
									</button>
								))}
								{versions.length === 0 && !historyBusy && <p>{t("versions.empty")}</p>}
							</div>
							{nextCursor && (
								<button
									type="button"
									className="secondary-button version-load-more"
									disabled={historyBusy}
									onClick={() => void loadVersions(nextCursor)}
								>
									{historyBusy ? <LoaderCircle className="spin" /> : <History />} {t("versions.loadMore")}
								</button>
							)}
						</div>

						<div className="version-preview-card">
							{previewBusy ? (
								<div className="version-preview-empty">
									<LoaderCircle className="spin" />
									<p>{t("versions.validating")}</p>
								</div>
							) : preview && selected && previewIsCurrent ? (
								<VersionPreview
									version={selected}
									preview={preview}
									isCurrentVersion={selected.version_id === currentVersion}
									writeBlockedReason={writeBlockedReason}
									busy={writeBusy}
									onRestore={handleRestore}
								/>
							) : (
								<div className="version-preview-empty">
									<History />
									<p>{t("versions.selectPreview")}</p>
								</div>
							)}
						</div>
					</div>
				</>
			) : null}
		</section>
	);
}

function VersionPreview({
	version,
	preview,
	isCurrentVersion,
	writeBlockedReason,
	busy,
	onRestore,
}: {
	version: ProjectVersion;
	preview: ProjectVersionPreview;
	isCurrentVersion: boolean;
	writeBlockedReason?: string;
	busy: boolean;
	onRestore(): Promise<void>;
}) {
	const { t } = useTranslation();
	return (
		<>
			<header className="version-preview-heading">
				<div>
					<strong>{version.message}</strong>
					<code>{version.version_id}</code>
				</div>
				{isCurrentVersion ? (
					<span className="auto-preview-status ready">
						<CheckCircle2 /> {t("versions.latest")}
					</span>
				) : (
					<button
						type="button"
						className="danger-button"
						disabled={!preview.can_restore || busy || Boolean(writeBlockedReason)}
						onClick={() => void onRestore()}
					>
						{busy ? <LoaderCircle className="spin" /> : <RotateCcw />} {t("versions.restore")}
					</button>
				)}
			</header>
			{preview.changes.length > 0 ? (
				preview.changes.map((change) => (
					<SourceFileDiff key={change.path} change={change} version={version.short_version} direction="restore" />
				))
			) : (
				<p className="version-preview-empty">{t("versions.matches")}</p>
			)}
			<div className={`commit-readiness ${isCurrentVersion || preview.can_restore ? "ready" : "blocked"}`}>
				{isCurrentVersion || preview.can_restore ? <CheckCircle2 /> : <AlertTriangle />}
				<span>
					{isCurrentVersion
						? t("versions.latestBaseline")
						: preview.can_restore
							? t("versions.readyRestore")
							: t("versions.restoreBlocked")}
				</span>
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

function VersionSummary({
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
		<div className={`version-summary-item ${tone ?? ""}`}>
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
