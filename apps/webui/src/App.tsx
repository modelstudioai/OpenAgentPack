import type { PlannedAction, SessionEvent } from "@openagentpack/sdk";
import {
	AlertTriangle,
	Box,
	Braces,
	CheckCircle2,
	ChevronRight,
	CircleDot,
	ExternalLink,
	FileText,
	LoaderCircle,
	Paperclip,
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
import {
	type Attachment,
	applyProject,
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
	type ProjectPlan,
	type ProjectSummary,
	type ProjectVersioningStatus,
	planProject,
	projectEventSource,
	type SessionDetail,
	sendSessionMessage,
	sessionEventSource,
	startSession,
	uploadAttachment,
} from "@/lib/project-api";
import { comparePlanActions } from "@/resources/plan-impact";
import { ResourcesPanel } from "@/resources/ResourcesPanel";
import { VersionsPanel } from "@/versions/VersionsPanel";

type WorkbenchTab = "overview" | "resources" | "changes" | "versions" | "debug" | "artifacts" | "deployments";

const TAB_LABELS: Array<{ id: WorkbenchTab; label: string }> = [
	{ id: "overview", label: "Overview" },
	{ id: "resources", label: "Resources" },
	{ id: "changes", label: "Changes" },
	{ id: "versions", label: "Versions" },
	{ id: "debug", label: "Debug" },
	{ id: "artifacts", label: "Artifacts" },
	{ id: "deployments", label: "Deployments" },
];
const ACTIVE_OPERATION_KEY = "openagentpack.playground.activeOperation";

export default function App() {
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
	const projectValid = project?.status === "valid";
	const writeBlockedReason = project?.active_mutation
		? `Project ${project.active_mutation.kind.replace(/_/g, " ")} is running. Drafts remain editable, but YAML and version writes are disabled until it finishes.`
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
				void (async () => {
					await loadProject(true);
					setPlanBusy(true);
					try {
						setPlan(await planProject());
					} catch (error) {
						if (!result.error) setActionError(errorMessage(error));
					} finally {
						setPlanBusy(false);
					}
				})();
				source.close();
			});
			source.onerror = () => {
				setActionError("Apply progress stream disconnected; reconnecting with the same operation ID…");
				void getOperation(operationId).catch((error) => {
					if ((error as { status?: number }).status !== 404) return;
					setApplyBusy(false);
					setActionError(
						"The Playground server restarted and interrupted this Apply. Create a fresh Plan before retrying.",
					);
					sessionStorage.removeItem(ACTIVE_OPERATION_KEY);
					source.close();
				});
			};
			source.onopen = () => setActionError(undefined);
		},
		[loadProject],
	);

	useEffect(() => {
		const operationId = sessionStorage.getItem(ACTIVE_OPERATION_KEY);
		if (!operationId) return;
		setApplyBusy(true);
		connectOperation(operationId);
	}, [connectOperation]);

	const handlePlan = async () => {
		setPlanBusy(true);
		setBaselinePlan(undefined);
		setActionError(undefined);
		setOperationEvents([]);
		try {
			setPlan(await planProject());
		} catch (error) {
			setActionError(errorMessage(error));
		} finally {
			setPlanBusy(false);
		}
	};

	const handleApply = async () => {
		if (!plan) return;
		if (plan.destructive && !window.confirm("This plan deletes remote resources. Apply the reviewed plan?")) return;
		setApplyBusy(true);
		setActionError(undefined);
		setOperationEvents([]);
		try {
			const accepted = await applyProject(plan.plan_token, plan.destructive);
			sessionStorage.setItem(ACTIVE_OPERATION_KEY, accepted.operation_id);
			connectOperation(accepted.operation_id);
		} catch (error) {
			setApplyBusy(false);
			setActionError(errorMessage(error));
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
		setPlanBusy(true);
		setOperationEvents([]);
		try {
			const nextPlan = await planProject();
			setPlan(nextPlan);
			setBaselinePlan(previousPlan);
		} catch (error) {
			setPlan(undefined);
			setBaselinePlan(undefined);
			setActionError(errorMessage(error));
		} finally {
			setPlanBusy(false);
		}
	};

	const handleVersionRestored = async () => {
		setTab("changes");
		setActionError(undefined);
		await loadProject(false, !selectedAgentId);
		await loadVersioningStatus();
		setPlanBusy(true);
		setBaselinePlan(undefined);
		setOperationEvents([]);
		try {
			setPlan(await planProject());
		} catch (error) {
			setPlan(undefined);
			setActionError(errorMessage(error));
		} finally {
			setPlanBusy(false);
		}
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
			setActionError("Session event stream disconnected; reconnecting from the last received event…");
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
					<span>OpenAgentPack</span>
					<small>Playground</small>
				</div>
				<div className="project-identity">
					<strong>{project?.project_name ?? "Loading project"}</strong>
					<span title={project?.config_file}>{project?.config_file ?? "agents.yaml"}</span>
				</div>
				<div className="project-health">
					<StatusPill status={reloading ? "loading" : (project?.status ?? "loading")} />
					{project?.revision && <code>{project.revision.slice(0, 9)}</code>}
					<button
						className="icon-button"
						type="button"
						title="Refresh readiness"
						onClick={() => void loadProject(true)}
					>
						<RefreshCw className={reloading ? "spin" : ""} />
					</button>
				</div>
			</header>

			{projectError && <Banner tone="error" message={projectError} />}
			{project && project.status !== "valid" && (
				<Banner
					tone="warning"
					message={`Project is ${project.status}. Existing Sessions remain available, but new Plan, Apply, upload, and Session operations are disabled.`}
				/>
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
						<span>Agents</span>
						<b>{project?.agents.length ?? 0}</b>
					</div>
					<div className="search-box">
						<Search />
						<input
							aria-label="Search agents"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							placeholder="Search agents"
						/>
					</div>
					<div className="filter-row">
						<select value={providerFilter} onChange={(event) => setProviderFilter(event.target.value)}>
							<option value="all">All providers</option>
							{providers.map((provider) => (
								<option key={provider}>{provider}</option>
							))}
						</select>
						<select value={readinessFilter} onChange={(event) => setReadinessFilter(event.target.value)}>
							<option value="all">All states</option>
							{["ready", "missing", "creating", "updating", "drifted", "unavailable", "invalid", "error"].map(
								(status) => (
									<option key={status}>{status}</option>
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
										{entry.agent.provider} · {entry.readiness.status}
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
													Preview
												</a>
											</div>
											<p>{selectedAgent.agent.description ?? "No description declared."}</p>
										</div>
										<ReadinessBadge agent={selectedAgent} />
									</>
								) : (
									<div>
										<div className="eyebrow">project / runtime</div>
										<h1>{project?.project_name ?? "Project"}</h1>
										<p>No Agent is currently selected. Resources and project Changes remain available.</p>
									</div>
								)}
							</section>
							<nav className="workspace-tabs">
								{TAB_LABELS.map((item) => (
									<button
										key={item.id}
										type="button"
										className={tab === item.id ? "active" : ""}
										onClick={() => setTab(item.id)}
									>
										{item.label}
									</button>
								))}
							</nav>
							{actionError && <Banner tone="error" message={actionError} compact />}
							{tab === "overview" &&
								(selectedAgent ? (
									<Overview agent={selectedAgent} />
								) : (
									<AgentRequiredPanel action="view its overview" />
								))}
							{tab === "resources" && selectedAgent && (
								<ResourcesPanel
									projectRevision={project?.revision}
									projectValid={projectValid}
									selectedAgentId={selectedAgent.agent.id}
									writeBlockedReason={writeBlockedReason}
									onCommitted={handleDeclarationCommitted}
								/>
							)}
							{tab === "resources" && !selectedAgent && <AgentRequiredPanel action="edit its resources" />}
							{tab === "changes" && (
								<ChangesPanel
									plan={plan}
									baselinePlan={baselinePlan}
									planBusy={planBusy}
									applyBusy={applyBusy}
									projectValid={projectValid}
									versioningEnabled={versioningStatus?.enabled ?? false}
									mutationActive={Boolean(project.active_mutation)}
									operationEvents={operationEvents}
									onPlan={handlePlan}
									onApply={handleApply}
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
							{tab === "debug" && !selectedAgent && <AgentRequiredPanel action="start a debug Session" />}
							{tab === "artifacts" && (
								<EventsPanel
									events={artifactEvents(sessionEvents)}
									empty="Artifacts and tool outputs will appear here after a run."
								/>
							)}
							{tab === "deployments" && selectedAgent && (
								<DeploymentsPanel
									deployments={(project?.deployments ?? []).filter(
										(deployment) => deployment.agent === selectedAgent.agent.id,
									)}
								/>
							)}
							{tab === "deployments" && !selectedAgent && <AgentRequiredPanel action="view Deployments" />}
						</>
					) : (
						<div className="empty-state">
							<ServerCog />
							<h2>No Agent selected</h2>
							<p>Fix agents.yaml or adjust the filters to select an existing Agent.</p>
						</div>
					)}
				</main>
			</div>
		</div>
	);
}

function Overview({ agent }: { agent: ProjectAgent }) {
	return (
		<section className="content-grid">
			<InfoCard
				icon={<Box />}
				title="Runtime"
				rows={[
					["Provider", agent.agent.provider],
					["Model", formatValue(agent.agent.model)],
					["Environment", agent.details.environment ?? "—"],
					["Vault", agent.details.vault ?? "—"],
				]}
			/>
			<InfoCard
				icon={<Braces />}
				title="Tools & MCP"
				rows={[
					["Builtins", formatValue((agent.agent.tools as { builtin?: string[] } | undefined)?.builtin ?? [])],
					["MCP servers", agent.agent.mcpServers.join(", ") || "—"],
				]}
			/>
			<InfoCard
				icon={<FileText />}
				title="Skills & memory"
				rows={[
					["Skills", agent.agent.skills.map((skill) => skill.id).join(", ") || "—"],
					["Memory stores", agent.details.memory_stores.join(", ") || "—"],
				]}
			/>
			<InfoCard
				icon={<Paperclip />}
				title="Declared resources"
				rows={
					agent.details.resources.length
						? agent.details.resources.map((resource) => [resource.type, resource.mount_path ?? "default mount"])
						: [["Resources", "—"]]
				}
			/>
		</section>
	);
}

function ChangesPanel({
	plan,
	baselinePlan,
	planBusy,
	applyBusy,
	projectValid,
	versioningEnabled,
	mutationActive,
	operationEvents,
	onPlan,
	onApply,
}: {
	plan?: ProjectPlan;
	baselinePlan?: ProjectPlan;
	planBusy: boolean;
	applyBusy: boolean;
	projectValid: boolean;
	versioningEnabled: boolean;
	mutationActive: boolean;
	operationEvents: OperationEvent[];
	onPlan(): void;
	onApply(): void;
}) {
	const impact = plan && baselinePlan ? comparePlanActions(baselinePlan.actions, plan.actions) : undefined;
	return (
		<section className="panel-stack">
			<div className="action-toolbar">
				<div>
					<h2>Project runtime resource plan</h2>
					<p>All declared runtime resources are in scope. Deployments and Channels are explicitly excluded.</p>
				</div>
				<div className="toolbar-buttons">
					<button
						type="button"
						className="secondary-button"
						disabled={!projectValid || planBusy || applyBusy || mutationActive}
						onClick={onPlan}
					>
						{planBusy ? <LoaderCircle className="spin" /> : <RefreshCw />}Plan
					</button>
					<button
						type="button"
						className="primary-button"
						disabled={!plan || applyBusy || mutationActive}
						onClick={onApply}
					>
						{applyBusy ? <LoaderCircle className="spin" /> : <Play />}Apply reviewed plan
					</button>
				</div>
			</div>
			{!versioningEnabled && (
				<div className="version-notice warning">
					<AlertTriangle />
					<span>Local versions are disabled. This Apply will not create a local agents.yaml version.</span>
				</div>
			)}
			{plan ? (
				<div className="plan-card">
					<div className="plan-meta">
						<span>{plan.actions.filter((action) => action.action !== "no-op").length} changes</span>
						<span>
							{plan.destructive ? (
								<>
									<ShieldAlert /> destructive
								</>
							) : (
								<>
									<CheckCircle2 /> non-destructive
								</>
							)}
						</span>
						<code>{plan.fingerprint.slice(0, 12)}</code>
					</div>
					{impact ? (
						<>
							<PlanActionGroup
								title="This edit"
								description="Actions introduced or changed by the declaration you just saved."
								actions={impact.currentEdit}
								empty="This edit introduced no Apply action."
							/>
							{impact.resolvedByEdit.length > 0 && <ResolvedPlanActions actions={impact.resolvedByEdit} />}
							<PlanActionGroup
								title="Already pending"
								description="These actions existed before this edit and are still included in the project Apply."
								actions={impact.alreadyPending}
								empty="No pre-existing project changes remain."
							/>
							<p className="plan-scope-notice">
								Apply reviewed plan executes both groups above. Resolved items require no remote action.
							</p>
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
			) : (
				<div className="empty-panel">
					<CircleDot />
					<p>Create a fresh plan to compare agents.yaml, state, and remote resources.</p>
				</div>
			)}
			{operationEvents.length > 0 && (
				<div className="operation-log">
					<h3>Apply progress</h3>
					{operationEvents.map((event) => (
						<div key={event.index}>
							<time>{new Date(event.timestamp).toLocaleTimeString()}</time>
							<strong>{event.type}</strong>
							<span>{operationMessage(event.data)}</span>
						</div>
					))}
				</div>
			)}
		</section>
	);
}

function AgentRequiredPanel({ action }: { action: string }) {
	return (
		<div className="empty-panel content-empty-panel">
			<ServerCog />
			<p>Select an existing Agent to {action}.</p>
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
	return (
		<section className="debug-layout">
			<div className="debug-controls">
				<div className="panel-card">
					<div className="panel-heading">
						<div>
							<h2>Temporary attachments</h2>
							<p>Uploaded for Sessions only; never written to agents.yaml.</p>
						</div>
						<label className={`upload-button ${!projectValid ? "disabled" : ""}`}>
							<Upload />
							{uploadBusy ? "Uploading…" : "Upload"}
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
									<small>{attachment.status ?? (attachment.available ? "available" : "pending")}</small>
								</span>
								<button
									type="button"
									title="Delete remote attachment"
									onClick={() => void onDeleteAttachment(attachment.id)}
								>
									<Trash2 />
								</button>
							</div>
						))}
						{attachments.length === 0 && <p className="muted-copy">No temporary attachments.</p>}
					</div>
				</div>
				<div className="panel-card">
					<h2>Start a Session</h2>
					<textarea
						value={prompt}
						onChange={(event) => onPrompt(event.target.value)}
						placeholder="Describe the task to run with this Agent…"
						rows={7}
					/>
					<button
						type="button"
						className="primary-button wide"
						disabled={!projectValid || busy || !prompt.trim()}
						onClick={onStart}
					>
						{busy ? <LoaderCircle className="spin" /> : <Play />}Start Session
					</button>
				</div>
			</div>
			<div className="session-console">
				<div className="console-heading">
					<div>
						<span>Live Session</span>
						<code>{session?.session.session_id ?? "not started"}</code>
					</div>
					{session && busy && (
						<button type="button" className="danger-button" onClick={onCancel}>
							<Square />
							Cancel
						</button>
					)}
				</div>
				<EventsPanel
					events={events}
					empty="Start a Session to inspect messages, reasoning, tool calls, and artifacts."
				/>
				{session && (
					<div className="followup-box">
						<textarea
							value={followup}
							onChange={(event) => onFollowup(event.target.value)}
							placeholder="Send a follow-up using the pinned Session runtime…"
							rows={3}
						/>
						<button
							type="button"
							className="primary-button"
							disabled={busy || !followup.trim()}
							onClick={onFollowupSend}
						>
							<Send />
							Send
						</button>
					</div>
				)}
			</div>
		</section>
	);
}

function DeploymentsPanel({ deployments }: { deployments: NonNullable<ProjectSummary["deployments"]> }) {
	return (
		<section className="panel-stack">
			<div className="readonly-note">
				<ShieldAlert />
				<span>
					Deployment declarations are read-only in Playground v1 and are excluded from Workbench project Plan/Apply. Use
					the CLI deployment flow for mutations.
				</span>
			</div>
			{deployments.length ? (
				deployments.map((deployment) => (
					<article className="deployment-card" key={deployment.id}>
						<div>
							<span className="eyebrow">deployment</span>
							<h3>{deployment.id}</h3>
							<p>{deployment.description ?? "No description declared."}</p>
						</div>
						<dl>
							<dt>Provider</dt>
							<dd>{deployment.provider ?? "inherited"}</dd>
							<dt>Schedule</dt>
							<dd>
								{deployment.schedule ? `${deployment.schedule.expression} (${deployment.schedule.timezone})` : "manual"}
							</dd>
							<dt>Initial events</dt>
							<dd>{deployment.initial_event_types.join(", ")}</dd>
							<dt>Resources</dt>
							<dd>{deployment.resource_types.join(", ") || "—"}</dd>
						</dl>
					</article>
				))
			) : (
				<div className="empty-panel">
					<ServerCog />
					<p>No Deployment references this Agent.</p>
				</div>
			)}
		</section>
	);
}

function EventsPanel({ events, empty }: { events: SessionEvent[]; empty: string }) {
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
								<time>{event.created_at ? new Date(event.created_at).toLocaleTimeString() : ""}</time>
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

function InfoCard({ icon, title, rows }: { icon: React.ReactNode; title: string; rows: string[][] }) {
	return (
		<article className="info-card">
			<header>
				{icon}
				<h2>{title}</h2>
			</header>
			<dl>
				{rows.map(([label, value]) => (
					<div key={label}>
						<dt>{label}</dt>
						<dd>{value}</dd>
					</div>
				))}
			</dl>
		</article>
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
	return (
		<section className="plan-action-group resolved">
			<header className="plan-action-group-heading">
				<span>
					<strong>Resolved by this edit</strong>
					<b>{actions.length}</b>
				</span>
				<small>These previously pending actions are no longer part of the project Plan.</small>
			</header>
			{actions.map((action) => (
				<div className="plan-action resolved" key={planActionKey(action)}>
					<span className="action-kind">cleared</span>
					<span>
						<strong>
							{displayPlanResourceType(action)}.{action.address.name}
						</strong>
						<small>Was pending {action.action} · no remote action remains</small>
					</span>
				</div>
			))}
		</section>
	);
}

function PlanActionRow({ action }: { action: PlannedAction }) {
	return (
		<div className={`plan-action ${action.action}`}>
			<span className="action-kind">{action.action}</span>
			<span>
				<strong>
					{displayPlanResourceType(action)}.{action.address.name}
				</strong>
				<small>
					{action.address.provider} · {action.reason}
				</small>
			</span>
			{action.changedPaths?.length ? <code>{action.changedPaths.join(", ")}</code> : null}
		</div>
	);
}

function displayPlanResourceType(action: PlannedAction): string {
	return action.address.type === "agent" || action.address.type === "template" ? "Agent" : action.address.type;
}

function planActionKey(action: PlannedAction): string {
	return `${action.action}-${action.address.provider}-${action.address.type}-${action.address.name}`;
}

function ReadinessBadge({ agent }: { agent: ProjectAgent }) {
	return (
		<div className={`readiness-badge ${agent.readiness.status}`}>
			<span />
			<div>
				<strong>{agent.readiness.status}</strong>
				<small>
					{agent.readiness.driftSeverity ??
						`${agent.readiness.plannedActions.filter((action) => action.action !== "no-op").length} planned changes`}
				</small>
			</div>
		</div>
	);
}

function StatusPill({ status }: { status: string }) {
	return (
		<span className={`status-pill ${status}`}>
			{status === "valid" ? (
				<CheckCircle2 />
			) : status === "loading" ? (
				<LoaderCircle className="spin" />
			) : (
				<AlertTriangle />
			)}
			{status}
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
