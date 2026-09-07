import type { PlannedAction, SessionEvent } from "@openagentpack/sdk";
import type { TFunction } from "i18next";
import {
	AlertTriangle,
	Braces,
	CheckCircle2,
	ChevronRight,
	CircleDot,
	ExternalLink,
	FileText,
	LoaderCircle,
	Play,
	RefreshCw,
	Search,
	Send,
	ServerCog,
	ShieldAlert,
	Square,
	Trash2,
	Upload,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { LanguageSwitcher } from "@/i18n/LanguageSwitcher";
import {
	type Attachment,
	applyProject,
	buildProject,
	cancelSession,
	type DeclarationType,
	deleteAttachment,
	getOperation,
	getProject,
	getProjectVersioning,
	listAttachments,
	type OperationEvent,
	operationEventSource,
	type ProjectAgent,
	type ProjectBuild,
	type ProjectPlan,
	type ProjectSummary,
	type ProjectVersioningStatus,
	type ProjectVersionPreview,
	planProject,
	previewProjectBuild,
	previewProjectVersion,
	projectEventSource,
	type SessionDetail,
	sendSessionMessage,
	sessionEventSource,
	startSession,
	uploadAttachment,
} from "@/lib/project-api";
import { comparePlanActions } from "@/resources/plan-impact";
import { ResourcesPanel } from "@/resources/ResourcesPanel";
import { SourceFileDiff } from "@/versions/SourceFileDiff";
import { VersionsPanel } from "@/versions/VersionsPanel";

type WorkbenchTab = "overview" | "changes" | "versions" | "debug" | "artifacts";

const WORKBENCH_TABS: WorkbenchTab[] = ["overview", "changes", "versions", "debug", "artifacts"];
const ACTIVE_OPERATION_KEY = "openagentpack.playground.activeOperation";

export default function App() {
	const { t } = useTranslation();
	const [project, setProject] = useState<ProjectSummary>();
	const [projectError, setProjectError] = useState<string>();
	const [reloading, setReloading] = useState(false);
	const [selectedAgentId, setSelectedAgentId] = useState("");
	const [query, setQuery] = useState("");
	const [providerFilter, setProviderFilter] = useState("all");
	const [readinessFilter, setReadinessFilter] = useState("all");
	const [tab, setTab] = useState<WorkbenchTab>("overview");
	const [plan, setPlan] = useState<ProjectPlan>();
	const [baselinePlan, setBaselinePlan] = useState<ProjectPlan>();
	const [planBusy, setPlanBusy] = useState(false);
	const [buildBusy, setBuildBusy] = useState(false);
	const [buildPreview, setBuildPreview] = useState<ProjectBuild>();
	const [sourcePreviewBusy, setSourcePreviewBusy] = useState(false);
	const [sourcePreview, setSourcePreview] = useState<ProjectVersionPreview>();
	const [sourcePreviewError, setSourcePreviewError] = useState<string>();
	const [applyBusy, setApplyBusy] = useState(false);
	const [operationEvents, setOperationEvents] = useState<OperationEvent[]>([]);
	const [actionError, setActionError] = useState<string>();
	const [versioningStatus, setVersioningStatus] = useState<ProjectVersioningStatus>();
	const [versioningError, setVersioningError] = useState<string>();
	const [versioningLoading, setVersioningLoading] = useState(true);
	const [attachments, setAttachments] = useState<Attachment[]>([]);
	const [selectedAttachments, setSelectedAttachments] = useState<string[]>([]);
	const [uploadBusy, setUploadBusy] = useState(false);
	const [prompt, setPrompt] = useState("");
	const [followup, setFollowup] = useState("");
	const [session, setSession] = useState<SessionDetail>();
	const [sessionEvents, setSessionEvents] = useState<SessionEvent[]>([]);
	const [sessionBusy, setSessionBusy] = useState(false);
	const operationSourceRef = useRef<EventSource | null>(null);
	const sessionSourceRef = useRef<EventSource | null>(null);
	const projectRef = useRef<ProjectSummary | undefined>(undefined);
	const projectRequestGenerationRef = useRef(0);
	const buildPreviewRequestGenerationRef = useRef(0);
	const sourcePreviewRequestGenerationRef = useRef(0);
	const projectValid = project?.status === "valid";
	const writeBlockedReason = project?.active_mutation
		? t("app.mutationRunning", { kind: project.active_mutation.kind.replace(/_/g, " ") })
		: undefined;

	const loadVersioningStatus = useCallback(async () => {
		setVersioningLoading(true);
		try {
			setVersioningStatus(await getProjectVersioning());
			setVersioningError(undefined);
		} catch (error) {
			setVersioningError(errorMessage(error));
		} finally {
			setVersioningLoading(false);
		}
	}, []);

	const loadProject = useCallback(async (refresh = false, preserveEmptySelection = false) => {
		const requestGeneration = ++projectRequestGenerationRef.current;
		try {
			const next = await getProject(refresh);
			if (requestGeneration !== projectRequestGenerationRef.current) return;
			projectRef.current = next;
			setProject(next);
			setProjectError(undefined);
			setSelectedAgentId((current) => {
				if (current && next.agents.some((entry) => entry.agent.id === current)) return current;
				return preserveEmptySelection ? "" : (next.agents[0]?.agent.id ?? "");
			});
		} catch (error) {
			if (requestGeneration !== projectRequestGenerationRef.current) return;
			setProjectError(errorMessage(error));
		} finally {
			if (requestGeneration === projectRequestGenerationRef.current) setReloading(false);
		}
	}, []);

	useEffect(() => {
		void loadProject();
		void loadVersioningStatus();
		const source = projectEventSource();
		source.addEventListener("project.snapshot", (event) => {
			let snapshot: { status?: unknown; revision?: unknown } | undefined;
			try {
				snapshot = JSON.parse((event as MessageEvent<string>).data) as typeof snapshot;
			} catch {
				// Reload below when an unexpected snapshot payload cannot be compared safely.
			}
			const current = projectRef.current;
			if (current && current.status === snapshot?.status && current.revision === snapshot.revision) return;
			setPlan(undefined);
			setBaselinePlan(undefined);
			setBuildPreview(undefined);
			setSourcePreview(undefined);
			setOperationEvents([]);
			void loadProject();
		});
		source.addEventListener("project.reloading", () => {
			projectRequestGenerationRef.current++;
			setReloading(true);
		});
		for (const type of ["project.valid", "project.invalid", "project.missing"] as const) {
			source.addEventListener(type, (event) => {
				let change: { status?: unknown; revision?: unknown } | undefined;
				try {
					change = JSON.parse((event as MessageEvent<string>).data) as typeof change;
				} catch {
					// Reload below when an unexpected change payload cannot be compared safely.
				}
				const current = projectRef.current;
				if (current && current.status === change?.status && current.revision === change.revision) {
					setReloading(false);
					return;
				}
				setPlan(undefined);
				setBaselinePlan(undefined);
				setBuildPreview(undefined);
				setSourcePreview(undefined);
				setOperationEvents([]);
				void loadProject();
			});
		}
		source.addEventListener("project.mutation", (event) => {
			let change: { active_mutation?: ProjectSummary["active_mutation"] } | undefined;
			try {
				change = JSON.parse((event as MessageEvent<string>).data) as typeof change;
			} catch {
				void loadProject();
				return;
			}
			setProject((current) => {
				if (!current) return current;
				const next = { ...current, active_mutation: change?.active_mutation ?? null };
				projectRef.current = next;
				return next;
			});
			if (!change?.active_mutation) void loadVersioningStatus();
		});
		return () => source.close();
	}, [loadVersioningStatus, loadProject]);

	useEffect(() => {
		if (project?.revision) void loadVersioningStatus();
	}, [loadVersioningStatus, project?.revision]);

	useEffect(() => {
		if (tab === "versions") void loadVersioningStatus();
	}, [loadVersioningStatus, tab]);

	useEffect(() => {
		setActionError(undefined);
		setSelectedAttachments([]);
		if (!selectedAgentId) {
			setAttachments([]);
			return;
		}
		void listAttachments(selectedAgentId)
			.then(setAttachments)
			.catch((error) => setActionError(errorMessage(error)));
	}, [selectedAgentId]);

	const hasPendingAttachments = attachments.some(
		(attachment) => !attachment.available && attachment.status !== "capability_unavailable",
	);
	useEffect(() => {
		if (!selectedAgentId || !projectValid || !hasPendingAttachments) return;
		const timer = setInterval(() => {
			void listAttachments(selectedAgentId)
				.then(setAttachments)
				.catch((error) => setActionError(errorMessage(error)));
		}, 3_000);
		return () => clearInterval(timer);
	}, [hasPendingAttachments, projectValid, selectedAgentId]);

	useEffect(
		() => () => {
			operationSourceRef.current?.close();
			sessionSourceRef.current?.close();
		},
		[],
	);

	const selectedAgent = project?.agents.find((entry) => entry.agent.id === selectedAgentId);
	const projectDirectory = project?.config_file ? directoryProjectPath(project.config_file) : undefined;
	const providers = useMemo(
		() => [...new Set((project?.agents ?? []).map((entry) => entry.agent.provider))].sort(),
		[project?.agents],
	);
	const filteredAgents = useMemo(() => {
		const normalizedQuery = query.trim().toLowerCase();
		return (project?.agents ?? []).filter((entry) => {
			if (providerFilter !== "all" && entry.agent.provider !== providerFilter) return false;
			if (readinessFilter !== "all" && entry.readiness.status !== readinessFilter) return false;
			return (
				!normalizedQuery ||
				entry.agent.id.toLowerCase().includes(normalizedQuery) ||
				(entry.agent.description ?? "").toLowerCase().includes(normalizedQuery)
			);
		});
	}, [project?.agents, providerFilter, query, readinessFilter]);

	const connectOperation = useCallback(
		(operationId: string) => {
			operationSourceRef.current?.close();
			const source = operationEventSource(operationId);
			operationSourceRef.current = source;
			source.addEventListener("event", (event) => {
				const operationEvent = JSON.parse((event as MessageEvent).data) as OperationEvent;
				setOperationEvents((current) => [
					...current.filter((item) => item.index !== operationEvent.index),
					operationEvent,
				]);
			});
			source.addEventListener("done", (event) => {
				const result = JSON.parse((event as MessageEvent).data) as { status: string; error?: string | null };
				setApplyBusy(false);
				setPlan(undefined);
				setBaselinePlan(undefined);
				sessionStorage.removeItem(ACTIVE_OPERATION_KEY);
				if (result.error) setActionError(result.error);
				void loadProject(true);
				source.close();
			});
			source.onerror = () => {
				setActionError(t("app.publishStreamDisconnected"));
				void getOperation(operationId).catch((error) => {
					if ((error as { status?: number }).status !== 404) return;
					setApplyBusy(false);
					setActionError(t("app.publishInterrupted"));
					sessionStorage.removeItem(ACTIVE_OPERATION_KEY);
					source.close();
				});
			};
			source.onopen = () => setActionError(undefined);
		},
		[loadProject, t],
	);

	useEffect(() => {
		const operationId = sessionStorage.getItem(ACTIVE_OPERATION_KEY);
		if (!operationId) return;
		setApplyBusy(true);
		connectOperation(operationId);
	}, [connectOperation]);

	const loadBuildPreview = useCallback(async (revision: string) => {
		const requestGeneration = ++buildPreviewRequestGenerationRef.current;
		setBuildBusy(true);
		setActionError(undefined);
		try {
			const preview = await previewProjectBuild(revision);
			if (requestGeneration !== buildPreviewRequestGenerationRef.current) return;
			setBuildPreview(preview);
		} catch (error) {
			if (requestGeneration !== buildPreviewRequestGenerationRef.current) return;
			setBuildPreview(undefined);
			setActionError(errorMessage(error));
		} finally {
			if (requestGeneration === buildPreviewRequestGenerationRef.current) setBuildBusy(false);
		}
	}, []);

	useEffect(() => {
		if (tab !== "changes" || !projectValid || !project?.revision || project.active_mutation) return;
		void loadBuildPreview(project.revision);
		return () => {
			buildPreviewRequestGenerationRef.current++;
			setBuildBusy(false);
		};
	}, [loadBuildPreview, project?.active_mutation, project?.revision, projectValid, tab]);

	const loadSourcePreview = useCallback(async (revision: string, headVersion: string) => {
		const requestGeneration = ++sourcePreviewRequestGenerationRef.current;
		setSourcePreviewBusy(true);
		setSourcePreviewError(undefined);
		try {
			const preview = await previewProjectVersion(headVersion, revision, headVersion);
			if (requestGeneration !== sourcePreviewRequestGenerationRef.current) return;
			setSourcePreview(preview);
		} catch (error) {
			if (requestGeneration !== sourcePreviewRequestGenerationRef.current) return;
			setSourcePreview(undefined);
			setSourcePreviewError(errorMessage(error));
		} finally {
			if (requestGeneration === sourcePreviewRequestGenerationRef.current) setSourcePreviewBusy(false);
		}
	}, []);

	useEffect(() => {
		if (tab !== "changes") return;
		const revision = project?.revision;
		const headVersion = versioningStatus?.head_version;
		if (!revision || !headVersion) {
			sourcePreviewRequestGenerationRef.current++;
			setSourcePreview(undefined);
			setSourcePreviewBusy(false);
			setSourcePreviewError(undefined);
			return;
		}
		void loadSourcePreview(revision, headVersion);
		return () => {
			sourcePreviewRequestGenerationRef.current++;
			setSourcePreviewBusy(false);
		};
	}, [loadSourcePreview, project?.revision, tab, versioningStatus?.head_version]);

	const handlePublish = async () => {
		if (!project?.revision) return;
		let preview = buildPreview;
		setBuildBusy(true);
		setPlan(undefined);
		setActionError(undefined);
		setOperationEvents([]);
		try {
			preview ??= await previewProjectBuild(project.revision);
			setBuildPreview(preview);
			if (!preview.can_build) throw new Error(t("app.projectCannotBuild"));
			await buildProject(project.revision);
			await loadProject(false, !selectedAgentId);
			setBuildBusy(false);

			setPlanBusy(true);
			const nextPlan = await planProject();
			setPlan(nextPlan);
			setPlanBusy(false);
			if (nextPlan.destructive && !window.confirm(t("app.confirmDestructivePublish"))) return;

			setApplyBusy(true);
			const accepted = await applyProject(nextPlan.plan_token, nextPlan.destructive);
			sessionStorage.setItem(ACTIVE_OPERATION_KEY, accepted.operation_id);
			connectOperation(accepted.operation_id);
		} catch (error) {
			setApplyBusy(false);
			setActionError(errorMessage(error));
		} finally {
			setBuildBusy(false);
			setPlanBusy(false);
		}
	};

	const handleDeclarationCommitted = async (
		change: {
			type: DeclarationType;
			id: string;
			action: "edit" | "delete";
		},
		previousPlan?: ProjectPlan,
	) => {
		const deletedSelectedAgent = change.action === "delete" && change.type === "agent" && change.id === selectedAgentId;
		if (deletedSelectedAgent) setSelectedAgentId("");
		setTab("changes");
		setActionError(undefined);
		await loadProject(false, deletedSelectedAgent);
		setBuildPreview(undefined);
		setSourcePreview(undefined);
		setOperationEvents([]);
		setPlan(undefined);
		setBaselinePlan(previousPlan);
	};

	const handleVersionRestored = async () => {
		setTab("changes");
		setActionError(undefined);
		await loadProject(false, !selectedAgentId);
		await loadVersioningStatus();
		setBuildPreview(undefined);
		setSourcePreview(undefined);
		setBaselinePlan(undefined);
		setOperationEvents([]);
		setPlan(undefined);
	};

	const handleUpload = async (fileList: FileList | null) => {
		if (!selectedAgent || !fileList?.length) return;
		setUploadBusy(true);
		setActionError(undefined);
		try {
			for (const file of Array.from(fileList)) {
				const attachment = await uploadAttachment(selectedAgent.agent.id, file);
				setAttachments((current) => [...current, attachment]);
				if (attachment.available) setSelectedAttachments((current) => [...current, attachment.id]);
			}
		} catch (error) {
			setActionError(errorMessage(error));
		} finally {
			setUploadBusy(false);
		}
	};

	const handleDeleteAttachment = async (attachmentId: string) => {
		setActionError(undefined);
		try {
			await deleteAttachment(attachmentId);
			setAttachments((current) => current.filter((attachment) => attachment.id !== attachmentId));
			setSelectedAttachments((current) => current.filter((id) => id !== attachmentId));
		} catch (error) {
			setActionError(errorMessage(error));
		}
	};

	const connectSession = (sessionId: string, initialEvents: SessionEvent[]) => {
		setSessionEvents(initialEvents);
		sessionSourceRef.current?.close();
		const source = sessionEventSource(sessionId, initialEvents.length - 1);
		sessionSourceRef.current = source;
		source.addEventListener("event", (event) => {
			const sessionEvent = JSON.parse((event as MessageEvent).data) as SessionEvent;
			setSessionEvents((current) => {
				if (sessionEvent.event_id && current.some((entry) => entry.event_id === sessionEvent.event_id)) return current;
				return [...current, sessionEvent];
			});
		});
		source.addEventListener("done", () => {
			setSessionBusy(false);
			source.close();
		});
		source.onerror = () => {
			setActionError(t("app.sessionStreamDisconnected"));
		};
		source.onopen = () => setActionError(undefined);
	};

	const handleStartSession = async () => {
		if (!selectedAgent || !prompt.trim()) return;
		setSessionBusy(true);
		setActionError(undefined);
		try {
			const detail = await startSession(selectedAgent.agent.id, prompt.trim(), selectedAttachments);
			setSession(detail);
			setPrompt("");
			connectSession(detail.session.session_id, detail.events);
		} catch (error) {
			setSessionBusy(false);
			setActionError(errorMessage(error));
		}
	};

	const handleFollowup = async () => {
		if (!session || !followup.trim()) return;
		setSessionBusy(true);
		setActionError(undefined);
		try {
			const detail = await sendSessionMessage(session.session.session_id, followup.trim());
			setSession(detail);
			setFollowup("");
			connectSession(detail.session.session_id, detail.events);
		} catch (error) {
			setSessionBusy(false);
			setActionError(errorMessage(error));
		}
	};

	const handleCancel = async () => {
		if (!session) return;
		try {
			await cancelSession(session.session.session_id);
			setSessionBusy(false);
			sessionSourceRef.current?.close();
		} catch (error) {
			setActionError(errorMessage(error));
		}
	};

	return (
		<div className="workbench-shell">
			<header className="workbench-header">
				<div className="brand-mark">
					<Braces />
					<span>Managed Agents</span>
					<small>{t("app.directoryWorkbench")}</small>
				</div>
				<div className="project-identity">
					<strong>{project?.project_name ?? t("app.loadingProject")}</strong>
					<span title={projectDirectory}>{projectDirectory ?? t("app.directoryProject")}</span>
				</div>
				<div className="project-health">
					<StatusPill status={reloading ? "loading" : (project?.status ?? "loading")} />
					{project?.revision && <code>{project.revision.slice(0, 9)}</code>}
					<LanguageSwitcher />
					<button
						className="icon-button"
						type="button"
						title={t("app.refreshReadiness")}
						onClick={() => void loadProject(true)}
					>
						<RefreshCw className={reloading ? "spin" : ""} />
					</button>
				</div>
			</header>

			{projectError && <Banner tone="error" message={projectError} />}
			{project && project.status !== "valid" && (
				<Banner tone="warning" message={t("app.projectUnavailable", { status: translateStatus(t, project.status) })} />
			)}
			{project?.diagnostics.map((diagnostic) => (
				<Banner
					key={`${diagnostic.code}-${diagnostic.resource?.provider ?? "project"}-${diagnostic.resource?.type ?? "config"}-${diagnostic.resource?.name ?? diagnostic.message}`}
					tone={diagnostic.severity === "error" ? "error" : "warning"}
					message={`${diagnostic.code}: ${diagnostic.message}`}
				/>
			))}
			{writeBlockedReason && <Banner tone="warning" message={writeBlockedReason} />}

			<div className="workbench-layout">
				<aside className="agent-sidebar">
					<div className="sidebar-heading">
						<span>{t("app.sidebar.agents")}</span>
						<b>{project?.agents.length ?? 0}</b>
					</div>
					<div className="search-box">
						<Search />
						<input
							aria-label={t("app.sidebar.search")}
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							placeholder={t("app.sidebar.search")}
						/>
					</div>
					<div className="filter-row">
						<select value={providerFilter} onChange={(event) => setProviderFilter(event.target.value)}>
							<option value="all">{t("app.sidebar.allProviders")}</option>
							{providers.map((provider) => (
								<option key={provider}>{provider}</option>
							))}
						</select>
						<select value={readinessFilter} onChange={(event) => setReadinessFilter(event.target.value)}>
							<option value="all">{t("app.sidebar.allStates")}</option>
							{["ready", "missing", "creating", "updating", "drifted", "unavailable", "invalid", "error"].map(
								(status) => (
									<option key={status} value={status}>
										{translateStatus(t, status)}
									</option>
								),
							)}
						</select>
					</div>
					<div className="agent-list">
						{filteredAgents.map((entry) => (
							<button
								key={entry.agent.id}
								type="button"
								className={`agent-item ${entry.agent.id === selectedAgentId ? "active" : ""}`}
								onClick={() => setSelectedAgentId(entry.agent.id)}
							>
								<span className={`readiness-dot ${entry.readiness.status}`} />
								<span className="agent-item-copy">
									<strong>{entry.agent.id}</strong>
									<small>
										{entry.agent.provider} · {translateStatus(t, entry.readiness.status)}
									</small>
								</span>
								<ChevronRight />
							</button>
						))}
					</div>
				</aside>

				<main className="agent-workspace">
					{project ? (
						<>
							<section className="agent-title-row">
								{selectedAgent ? (
									<>
										<div>
											<div className="eyebrow">{selectedAgent.agent.provider} / agent</div>
											<div className="agent-name-row">
												<h1>{selectedAgent.agent.id}</h1>
												<a
													className="agent-preview-link"
													href={
														session
															? `/sessions/${encodeURIComponent(session.session.session_id)}/preview`
															: `/agents/${encodeURIComponent(selectedAgent.agent.id)}/preview`
													}
													target="_blank"
													rel="noreferrer"
												>
													<ExternalLink />
													{t("app.agent.preview")}
												</a>
											</div>
											<p>{selectedAgent.agent.description ?? t("app.agent.noDescription")}</p>
										</div>
										<ReadinessBadge agent={selectedAgent} />
									</>
								) : (
									<div>
										<div className="eyebrow">{t("app.agent.projectRuntime")}</div>
										<h1>{project?.project_name ?? t("app.agent.project")}</h1>
										<p>{t("app.agent.noSelection")}</p>
									</div>
								)}
							</section>
							{selectedAgent && <ReadinessDiagnostics agent={selectedAgent} />}
							<nav className="workspace-tabs">
								{WORKBENCH_TABS.map((item) => (
									<button
										key={item}
										type="button"
										className={tab === item ? "active" : ""}
										onClick={() => setTab(item)}
									>
										{t(`app.tabs.${item}`)}
									</button>
								))}
							</nav>
							{actionError && <Banner tone="error" message={actionError} compact />}
							{tab === "overview" &&
								(selectedAgent ? (
									<ResourcesPanel
										projectRevision={project?.revision}
										projectValid={projectValid}
										selectedAgentId={selectedAgent.agent.id}
										writeBlockedReason={writeBlockedReason}
										onCommitted={handleDeclarationCommitted}
									/>
								) : (
									<AgentRequiredPanel action={t("app.agent.selectToEdit")} />
								))}
							{tab === "changes" && (
								<ChangesPanel
									plan={plan}
									baselinePlan={baselinePlan}
									buildPreview={buildPreview}
									buildBusy={buildBusy}
									sourcePreview={sourcePreview}
									sourcePreviewBusy={sourcePreviewBusy || versioningLoading}
									sourcePreviewError={sourcePreviewError ?? versioningError}
									versioningInitialized={versioningStatus?.initialized ?? false}
									headVersion={versioningStatus?.head_version ?? null}
									planBusy={planBusy}
									applyBusy={applyBusy}
									projectValid={projectValid}
									versioningEnabled={versioningStatus?.enabled ?? false}
									mutationActive={Boolean(project.active_mutation)}
									operationEvents={operationEvents}
									onPublish={handlePublish}
								/>
							)}
							{tab === "versions" && (
								<VersionsPanel
									projectRevision={project.revision}
									versioning={versioningStatus}
									versioningLoading={versioningLoading}
									versioningError={versioningError}
									writeBlockedReason={writeBlockedReason}
									onVersioningChange={setVersioningStatus}
									onRestored={handleVersionRestored}
								/>
							)}
							{tab === "debug" && selectedAgent && (
								<DebugPanel
									agent={selectedAgent}
									projectValid={projectValid}
									attachments={attachments}
									selectedAttachments={selectedAttachments}
									uploadBusy={uploadBusy}
									prompt={prompt}
									followup={followup}
									session={session}
									events={sessionEvents}
									busy={sessionBusy}
									onPrompt={setPrompt}
									onFollowup={setFollowup}
									onToggleAttachment={(id) =>
										setSelectedAttachments((current) =>
											current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id],
										)
									}
									onUpload={handleUpload}
									onDeleteAttachment={handleDeleteAttachment}
									onStart={handleStartSession}
									onFollowupSend={handleFollowup}
									onCancel={handleCancel}
								/>
							)}
							{tab === "debug" && !selectedAgent && <AgentRequiredPanel action={t("app.agent.selectToDebug")} />}
							{tab === "artifacts" && (
								<EventsPanel events={artifactEvents(sessionEvents)} empty={t("app.debug.artifactsEmpty")} />
							)}
						</>
					) : (
						<div className="empty-state">
							<ServerCog />
							<h2>{t("app.agent.noAgentSelected")}</h2>
							<p>{t("app.agent.fixOrFilter")}</p>
						</div>
					)}
				</main>
			</div>
		</div>
	);
}

function ChangesPanel({
	plan,
	baselinePlan,
	buildPreview,
	buildBusy,
	sourcePreview,
	sourcePreviewBusy,
	sourcePreviewError,
	versioningInitialized,
	headVersion,
	planBusy,
	applyBusy,
	projectValid,
	versioningEnabled,
	mutationActive,
	operationEvents,
	onPublish,
}: {
	plan?: ProjectPlan;
	baselinePlan?: ProjectPlan;
	buildPreview?: ProjectBuild;
	buildBusy: boolean;
	sourcePreview?: ProjectVersionPreview;
	sourcePreviewBusy: boolean;
	sourcePreviewError?: string;
	versioningInitialized: boolean;
	headVersion: string | null;
	planBusy: boolean;
	applyBusy: boolean;
	projectValid: boolean;
	versioningEnabled: boolean;
	mutationActive: boolean;
	operationEvents: OperationEvent[];
	onPublish(): void;
}) {
	const { i18n, t } = useTranslation();
	const impact = plan && baselinePlan ? comparePlanActions(baselinePlan.actions, plan.actions) : undefined;
	return (
		<section className="panel-stack">
			<div className="action-toolbar">
				<div>
					<h2>{t("app.changes.title")}</h2>
					<p>{t("app.changes.description")}</p>
				</div>
				<div className="toolbar-buttons">
					<span
						className={`auto-preview-status ${
							buildBusy ? "loading" : buildPreview?.can_build ? "ready" : buildPreview ? "blocked" : ""
						}`}
					>
						{buildBusy ? (
							<LoaderCircle className="spin" />
						) : buildPreview?.can_build ? (
							<CheckCircle2 />
						) : buildPreview ? (
							<AlertTriangle />
						) : (
							<RefreshCw />
						)}
						{buildBusy
							? t("app.changes.checking")
							: buildPreview?.can_build
								? t("app.changes.ready")
								: buildPreview
									? t("app.changes.attention")
									: t("app.changes.automaticChecks")}
					</span>
					<button
						type="button"
						className="primary-button"
						disabled={!projectValid || !buildPreview?.can_build || buildBusy || planBusy || applyBusy || mutationActive}
						onClick={onPublish}
					>
						{buildBusy || planBusy || applyBusy ? <LoaderCircle className="spin" /> : <Play />}
						{buildBusy
							? t("app.changes.preparing")
							: planBusy
								? t("app.changes.planning")
								: applyBusy
									? t("app.changes.publishing")
									: t("app.changes.publish")}
					</button>
				</div>
			</div>
			<SourceChangesCard
				preview={sourcePreview}
				busy={sourcePreviewBusy}
				error={sourcePreviewError}
				initialized={versioningInitialized}
				headVersion={headVersion}
			/>
			{buildPreview && <PublishChecks preview={buildPreview} />}
			{!versioningEnabled && (
				<div className="version-notice warning">
					<AlertTriangle />
					<span>{t("app.changes.versionsDisabled")}</span>
				</div>
			)}
			{plan && (
				<div className="plan-card">
					<div className="plan-meta">
						<span>
							{t("app.changes.changeCount", {
								count: plan.actions.filter((action) => action.action !== "no-op").length,
							})}
						</span>
						<span>
							{plan.destructive ? (
								<>
									<ShieldAlert /> {t("app.changes.destructive")}
								</>
							) : (
								<>
									<CheckCircle2 /> {t("app.changes.nonDestructive")}
								</>
							)}
						</span>
						<code>{plan.fingerprint.slice(0, 12)}</code>
					</div>
					{impact ? (
						<>
							<PlanActionGroup
								title={t("app.changes.thisEdit")}
								description={t("app.changes.thisEditDescription")}
								actions={impact.currentEdit}
								empty={t("app.changes.thisEditEmpty")}
							/>
							{impact.resolvedByEdit.length > 0 && <ResolvedPlanActions actions={impact.resolvedByEdit} />}
							<PlanActionGroup
								title={t("app.changes.alreadyPending")}
								description={t("app.changes.alreadyPendingDescription")}
								actions={impact.alreadyPending}
								empty={t("app.changes.alreadyPendingEmpty")}
							/>
							<p className="plan-scope-notice">{t("app.changes.planScope")}</p>
						</>
					) : (
						plan.actions.map((action) => <PlanActionRow key={planActionKey(action)} action={action} />)
					)}
					{plan.diagnostics.map((diagnostic) => (
						<div className={`plan-diagnostic ${diagnostic.severity}`} key={`${diagnostic.code}:${diagnostic.message}`}>
							<strong>{diagnostic.code}</strong>
							<span>{diagnostic.message}</span>
						</div>
					))}
				</div>
			)}
			{operationEvents.length > 0 && (
				<div className="operation-log">
					<h3>{t("app.changes.progress")}</h3>
					{operationEvents.map((event) => (
						<div key={event.index}>
							<time>{new Date(event.timestamp).toLocaleTimeString(i18n.resolvedLanguage)}</time>
							<strong>{event.type}</strong>
							<span>{operationMessage(event.data)}</span>
						</div>
					))}
				</div>
			)}
		</section>
	);
}

function SourceChangesCard({
	preview,
	busy,
	error,
	initialized,
	headVersion,
}: {
	preview?: ProjectVersionPreview;
	busy: boolean;
	error?: string;
	initialized: boolean;
	headVersion: string | null;
}) {
	const { t } = useTranslation();
	return (
		<div className="plan-card">
			<div className="plan-meta">
				<strong>{t("app.changes.sourceChanges")}</strong>
				{headVersion && <code>{t("app.changes.baseline", { version: headVersion.slice(0, 12) })}</code>}
				{preview && <span>{t("app.changes.changedFiles", { count: preview.changes.length })}</span>}
			</div>
			{busy ? (
				<div className="version-preview-empty">
					<LoaderCircle className="spin" />
					<p>{t("app.changes.comparing")}</p>
				</div>
			) : error ? (
				<div className="version-notice warning">
					<AlertTriangle />
					<span>{error}</span>
				</div>
			) : !initialized || !headVersion ? (
				<div className="version-notice warning">
					<AlertTriangle />
					<span>{t("app.changes.enableBaseline")}</span>
				</div>
			) : preview ? (
				preview.changes.length > 0 ? (
					preview.changes.map((change) => (
						<SourceFileDiff
							key={change.path}
							change={change}
							version={headVersion.slice(0, 12)}
							direction="working-tree"
						/>
					))
				) : (
					<p className="version-preview-empty">{t("app.changes.matchesLatest")}</p>
				)
			) : (
				<p className="version-preview-empty">{t("app.changes.waitingComparison")}</p>
			)}
		</div>
	);
}

function PublishChecks({ preview }: { preview: ProjectBuild }) {
	const { t } = useTranslation();
	const diagnostics = [...preview.diagnostics, ...preview.warnings];
	if (preview.organization_moves.length === 0 && diagnostics.length === 0) return null;
	return (
		<div className="plan-card">
			<div className="plan-meta">
				<strong>{t("app.changes.publishChecks")}</strong>
				<span>{t("app.changes.organizationMoves", { count: preview.organization_moves.length })}</span>
				<span>{t("app.changes.diagnostics", { count: diagnostics.length })}</span>
			</div>
			{preview.organization_moves.map((move) => (
				<div className="plan-diagnostic warning" key={`${move.from}:${move.to}`}>
					<strong>
						{t("app.changes.moveSharedResource", {
							type: t(`resources.kinds.${move.resource_type}`),
							resource: move.resource_id,
						})}
					</strong>
					<span>
						{move.from} → {move.to}
					</span>
				</div>
			))}
			{diagnostics.map((diagnostic) => (
				<div className={`plan-diagnostic ${diagnostic.severity}`} key={`${diagnostic.code}:${diagnostic.message}`}>
					<strong>{diagnostic.code}</strong>
					<span>{diagnostic.message}</span>
				</div>
			))}
		</div>
	);
}

function AgentRequiredPanel({ action }: { action: string }) {
	const { t } = useTranslation();
	return (
		<div className="empty-panel content-empty-panel">
			<ServerCog />
			<p>{t("app.agent.required", { action })}</p>
		</div>
	);
}

function DebugPanel({
	projectValid,
	attachments,
	selectedAttachments,
	uploadBusy,
	prompt,
	followup,
	session,
	events,
	busy,
	onPrompt,
	onFollowup,
	onToggleAttachment,
	onUpload,
	onDeleteAttachment,
	onStart,
	onFollowupSend,
	onCancel,
}: {
	agent: ProjectAgent;
	projectValid: boolean;
	attachments: Attachment[];
	selectedAttachments: string[];
	uploadBusy: boolean;
	prompt: string;
	followup: string;
	session?: SessionDetail;
	events: SessionEvent[];
	busy: boolean;
	onPrompt(value: string): void;
	onFollowup(value: string): void;
	onToggleAttachment(id: string): void;
	onUpload(files: FileList | null): void;
	onDeleteAttachment(id: string): void;
	onStart(): void;
	onFollowupSend(): void;
	onCancel(): void;
}) {
	const { t } = useTranslation();
	return (
		<section className="debug-layout">
			<div className="debug-controls">
				<div className="panel-card">
					<div className="panel-heading">
						<div>
							<h2>{t("app.debug.temporaryAttachments")}</h2>
							<p>{t("app.debug.attachmentsDescription")}</p>
						</div>
						<label className={`upload-button ${!projectValid ? "disabled" : ""}`}>
							<Upload />
							{uploadBusy ? t("app.debug.uploading") : t("app.debug.upload")}
							<input
								type="file"
								multiple
								disabled={!projectValid || uploadBusy}
								onChange={(event) => {
									void onUpload(event.target.files);
									event.target.value = "";
								}}
							/>
						</label>
					</div>
					<div className="attachment-list">
						{attachments.map((attachment) => (
							<div key={attachment.id} className="attachment-row">
								<input
									type="checkbox"
									checked={selectedAttachments.includes(attachment.id)}
									disabled={!attachment.available}
									onChange={() => onToggleAttachment(attachment.id)}
								/>
								<FileText />
								<span>
									<strong>{attachment.filename}</strong>
									<small>
										{translateStatus(t, attachment.status ?? (attachment.available ? "available" : "pending"))}
									</small>
								</span>
								<button
									type="button"
									title={t("app.debug.deleteAttachment")}
									onClick={() => void onDeleteAttachment(attachment.id)}
								>
									<Trash2 />
								</button>
							</div>
						))}
						{attachments.length === 0 && <p className="muted-copy">{t("app.debug.noAttachments")}</p>}
					</div>
				</div>
				<div className="panel-card">
					<h2>{t("app.debug.startSession")}</h2>
					<textarea
						value={prompt}
						onChange={(event) => onPrompt(event.target.value)}
						placeholder={t("app.debug.taskPlaceholder")}
						rows={7}
					/>
					<button
						type="button"
						className="primary-button wide"
						disabled={!projectValid || busy || !prompt.trim()}
						onClick={onStart}
					>
						{busy ? <LoaderCircle className="spin" /> : <Play />}
						{t("app.debug.startSession")}
					</button>
				</div>
			</div>
			<div className="session-console">
				<div className="console-heading">
					<div>
						<span>{t("app.debug.liveSession")}</span>
						<code>{session?.session.session_id ?? t("app.debug.notStarted")}</code>
					</div>
					{session && busy && (
						<button type="button" className="danger-button" onClick={onCancel}>
							<Square />
							{t("app.debug.cancel")}
						</button>
					)}
				</div>
				<EventsPanel events={events} empty={t("app.debug.empty")} />
				{session && (
					<div className="followup-box">
						<textarea
							value={followup}
							onChange={(event) => onFollowup(event.target.value)}
							placeholder={t("app.debug.followupPlaceholder")}
							rows={3}
						/>
						<button
							type="button"
							className="primary-button"
							disabled={busy || !followup.trim()}
							onClick={onFollowupSend}
						>
							<Send />
							{t("app.debug.send")}
						</button>
					</div>
				)}
			</div>
		</section>
	);
}

function EventsPanel({ events, empty }: { events: SessionEvent[]; empty: string }) {
	const { i18n } = useTranslation();
	return (
		<div className="event-list">
			{events.length ? (
				events.map((event, index) => (
					<article
						className={`event-row ${event.is_error ? "error" : ""}`}
						key={event.event_id ?? `${event.type}-${index}`}
					>
						<div className="event-icon">{event.is_error ? <AlertTriangle /> : <CircleDot />}</div>
						<div>
							<header>
								<strong>{event.type}</strong>
								<span>{event.role}</span>
								<time>
									{event.created_at ? new Date(event.created_at).toLocaleTimeString(i18n.resolvedLanguage) : ""}
								</time>
							</header>
							{event.message && <p>{event.message}</p>}
							{event.content?.map((block) => (
								<div className="event-content" key={JSON.stringify(block)}>
									{block.text ?? (block.data !== undefined ? formatValue(block.data) : block.type)}
								</div>
							))}
						</div>
					</article>
				))
			) : (
				<div className="empty-panel">
					<CircleDot />
					<p>{empty}</p>
				</div>
			)}
		</div>
	);
}

function PlanActionGroup({
	title,
	description,
	actions,
	empty,
}: {
	title: string;
	description: string;
	actions: PlannedAction[];
	empty: string;
}) {
	return (
		<section className="plan-action-group">
			<header className="plan-action-group-heading">
				<span>
					<strong>{title}</strong>
					<b>{actions.length}</b>
				</span>
				<small>{description}</small>
			</header>
			{actions.length > 0 ? (
				actions.map((action) => <PlanActionRow key={planActionKey(action)} action={action} />)
			) : (
				<p className="plan-action-group-empty">{empty}</p>
			)}
		</section>
	);
}

function ResolvedPlanActions({ actions }: { actions: PlannedAction[] }) {
	const { t } = useTranslation();
	return (
		<section className="plan-action-group resolved">
			<header className="plan-action-group-heading">
				<span>
					<strong>{t("app.changes.resolved")}</strong>
					<b>{actions.length}</b>
				</span>
				<small>{t("app.changes.resolvedDescription")}</small>
			</header>
			{actions.map((action) => (
				<div className="plan-action resolved" key={planActionKey(action)}>
					<span className="action-kind">{t("app.changes.cleared")}</span>
					<span>
						<strong>
							{displayPlanResourceType(t, action)}.{action.address.name}
						</strong>
						<small>{t("app.changes.wasPending", { action: translatePlanAction(t, action.action) })}</small>
					</span>
				</div>
			))}
		</section>
	);
}

function PlanActionRow({ action }: { action: PlannedAction }) {
	const { t } = useTranslation();
	return (
		<div className={`plan-action ${action.action}`}>
			<span className="action-kind">{translatePlanAction(t, action.action)}</span>
			<span>
				<strong>
					{displayPlanResourceType(t, action)}.{action.address.name}
				</strong>
				<small>
					{action.address.provider} · {action.reason}
				</small>
			</span>
			{action.changedPaths?.length ? <code>{action.changedPaths.join(", ")}</code> : null}
		</div>
	);
}

function displayPlanResourceType(t: TFunction, action: PlannedAction): string {
	if (action.address.type === "agent" || action.address.type === "template") return t("resources.kinds.agent");
	return t(`resources.kinds.${action.address.type}`, { defaultValue: action.address.type });
}

function planActionKey(action: PlannedAction): string {
	return `${action.action}-${action.address.provider}-${action.address.type}-${action.address.name}`;
}

function translatePlanAction(t: TFunction, action: PlannedAction["action"]): string {
	return t(`common.actions.${action.replace("-", "_")}`, { defaultValue: action });
}

const STATUS_TRANSLATION_KEYS = {
	loading: "common.loading",
	valid: "common.valid",
	invalid: "common.invalid",
	ready: "common.ready",
	missing: "common.missing",
	creating: "common.creating",
	updating: "common.updating",
	drifted: "common.drifted",
	unavailable: "common.unavailable",
	error: "common.error",
	available: "common.available",
	pending: "common.pending",
} as const;

function translateStatus(t: TFunction, status: string): string {
	const key = STATUS_TRANSLATION_KEYS[status as keyof typeof STATUS_TRANSLATION_KEYS];
	return key ? t(key) : status;
}

function directoryProjectPath(configFile: string): string {
	return configFile.replace(/[\\/]\.openagentpack[\\/]build[\\/]agents\.yaml$/u, "");
}

function ReadinessBadge({ agent }: { agent: ProjectAgent }) {
	const { t } = useTranslation();
	return (
		<div className={`readiness-badge ${agent.readiness.status}`}>
			<span />
			<div>
				<strong>{translateStatus(t, agent.readiness.status)}</strong>
				<small>
					{agent.readiness.driftSeverity ??
						t("app.changes.plannedChanges", {
							count: agent.readiness.plannedActions.filter((action) => action.action !== "no-op").length,
						})}
				</small>
			</div>
		</div>
	);
}

function ReadinessDiagnostics({ agent }: { agent: ProjectAgent }) {
	const { t } = useTranslation();
	const diagnostics = agent.readiness.diagnostics;
	if (diagnostics.length === 0) return null;
	const hasErrors = diagnostics.some((diagnostic) => diagnostic.severity === "error");
	return (
		<section
			className={`readiness-diagnostics ${hasErrors ? "error" : "warning"}`}
			aria-label={t("app.readiness.aria")}
		>
			<header>
				<AlertTriangle />
				<div>
					<strong>{t("app.readiness.why", { status: translateStatus(t, agent.readiness.status) })}</strong>
					<small>{t("app.readiness.resolveBeforeDebug")}</small>
				</div>
			</header>
			<ul>
				{diagnostics.map((diagnostic) => (
					<li className={diagnostic.severity} key={`${diagnostic.code}:${diagnostic.message}`}>
						<code>{diagnostic.code}</code>
						<span>{diagnostic.message}</span>
					</li>
				))}
			</ul>
		</section>
	);
}

function StatusPill({ status }: { status: string }) {
	const { t } = useTranslation();
	return (
		<span className={`status-pill ${status}`}>
			{status === "valid" ? (
				<CheckCircle2 />
			) : status === "loading" ? (
				<LoaderCircle className="spin" />
			) : (
				<AlertTriangle />
			)}
			{translateStatus(t, status)}
		</span>
	);
}

function Banner({ tone, message, compact = false }: { tone: "error" | "warning"; message: string; compact?: boolean }) {
	return (
		<div className={`workbench-banner ${tone} ${compact ? "compact" : ""}`}>
			{tone === "error" ? <AlertTriangle /> : <ShieldAlert />}
			<span>{message}</span>
		</div>
	);
}

function artifactEvents(events: SessionEvent[]): SessionEvent[] {
	return events.filter(
		(event) =>
			/result|output|artifact|file/i.test(event.type) || event.content?.some((block) => block.data !== undefined),
	);
}

function operationMessage(data: unknown): string {
	if (
		data &&
		typeof data === "object" &&
		"message" in data &&
		typeof (data as { message?: unknown }).message === "string"
	)
		return (data as { message: string }).message;
	return typeof data === "string" ? data : "";
}

function formatValue(value: unknown): string {
	if (value === undefined || value === null || value === "") return "—";
	if (typeof value === "string") return value;
	return JSON.stringify(value);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
