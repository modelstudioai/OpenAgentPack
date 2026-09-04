import { ArrowLeft, ArrowUp, CircleAlert, Copy, Loader2, Radio, StopCircle, X } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { RunTimelineItemView } from "@/components/task-run-modal/RunTimelineItemView";
import { ArtifactAccessProvider } from "@/lib/artifact-access-context";
import { buildRunTimeline, shouldShowAgentReplying } from "@/lib/view/run-timeline";
import { SessionPreviewSidePanel } from "./SessionPreviewSidePanel";
import { useProjectSessionPreview } from "./useProjectSessionPreview";
import "@/app/session-preview.css";

export function SessionPreviewPage({ sessionId }: { sessionId: string }) {
	const preview = useProjectSessionPreview(sessionId);
	const [message, setMessage] = useState("");
	const [copied, setCopied] = useState(false);
	const inputRef = useRef<HTMLTextAreaElement>(null);
	const messagesRef = useRef<HTMLDivElement>(null);
	const stickToBottomRef = useRef(true);
	const timelineItems = useMemo(
		() => buildRunTimeline(preview.events, { isRunning: preview.busy, includeLeadingUser: true }),
		[preview.busy, preview.events],
	);
	const session = preview.detail?.session;
	const terminated = session?.status === "terminated" || session?.status === "deleted";
	const showReplying = shouldShowAgentReplying({
		isRunning: preview.busy,
		sendSending: preview.busy,
		isCreating: preview.loading,
		isLoadingDetails: preview.loading,
		timelineItems,
	});

	useEffect(() => {
		document.body.classList.add("session-preview-active");
		document.title = `${preview.detail?.agent_name ?? "Agent"} · Managed Agents Preview`;
		return () => document.body.classList.remove("session-preview-active");
	}, [preview.detail?.agent_name]);

	useLayoutEffect(() => {
		const element = messagesRef.current;
		if (!element || !stickToBottomRef.current) return;
		element.scrollTop = element.scrollHeight;
	});

	const submit = async () => {
		const value = message.trim();
		if (!value || preview.busy || terminated) return;
		try {
			await preview.send(value);
			setMessage("");
		} catch {
			// The controller exposes the actionable error in-page.
		}
	};

	const terminate = async () => {
		if (!window.confirm("Terminate this remote Session? It cannot be resumed after termination.")) return;
		try {
			await preview.terminate();
		} catch {
			// The controller exposes the actionable error in-page.
		}
	};

	const copySessionId = async () => {
		await navigator.clipboard.writeText(sessionId).catch(() => undefined);
		setCopied(true);
		window.setTimeout(() => setCopied(false), 1500);
	};

	const closePreview = () => {
		window.close();
		window.setTimeout(() => {
			if (!window.closed) window.location.assign("/");
		}, 50);
	};

	const locateTimelineItem = (timelineKey: string) => {
		const target = document.getElementById(timelineDomId(timelineKey));
		if (!target) return;
		stickToBottomRef.current = false;
		target.scrollIntoView({ behavior: "smooth", block: "center" });
		target.classList.remove("located");
		window.requestAnimationFrame(() => target.classList.add("located"));
		window.setTimeout(() => target.classList.remove("located"), 1600);
	};

	return (
		<ArtifactAccessProvider
			onRegenerate={preview.regenerate}
			onResolveDeliveredFile={preview.resolveDeliveredFile}
			regenerateBusy={preview.busy}
		>
			<div className="session-preview">
				<header className="session-preview-header">
					<a className="session-preview-back" href="/" aria-label="Back to project workbench">
						<ArrowLeft />
					</a>
					<div className="session-preview-identity">
						<span className="session-preview-eyebrow">Preview · {preview.detail?.provider ?? "Managed Agents"}</span>
						<div className="session-preview-title-row">
							<h1>{preview.detail?.agent_name ?? "Loading Agent…"}</h1>
							<PreviewStatus status={session?.status} streamState={preview.streamState} busy={preview.busy} />
						</div>
						<button type="button" onClick={() => void copySessionId()} title="Copy Session ID">
							<code>{sessionId}</code>
							<Copy />
							{copied && <span>Copied</span>}
						</button>
					</div>
					<div className="session-preview-actions">
						<button
							type="button"
							className="session-preview-terminate"
							disabled={preview.loading || terminated}
							onClick={() => void terminate()}
						>
							<StopCircle />
							Terminate
						</button>
						<button type="button" className="session-preview-close" onClick={closePreview}>
							<X />
							Close
						</button>
					</div>
				</header>

				{preview.error && !preview.detail && <div className="session-preview-banner error">{preview.error}</div>}
				{preview.streamNotice && <div className="session-preview-banner warning">{preview.streamNotice}</div>}

				<main className="session-preview-main">
					<div className="session-preview-content">
						<div className="session-preview-chat">
							<div
								className="session-preview-messages"
								ref={messagesRef}
								onScroll={(event) => {
									const element = event.currentTarget;
									stickToBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 72;
								}}
							>
								<div className="session-preview-timeline">
									{preview.loading ? (
										<div className="session-preview-state">
											<Loader2 className="spin" />
											正在加载 Session 记录…
										</div>
									) : !preview.detail ? (
										<div className="session-preview-state error">
											<h2>{unavailableCopy(preview.unavailableReason).title}</h2>
											<p>{unavailableCopy(preview.unavailableReason).body}</p>
											<a href="/">返回项目工作台</a>
										</div>
									) : (
										<>
											{timelineItems.length === 0 && !preview.busy ? (
												<div className="session-preview-welcome">
													<span className="session-preview-agent-avatar">
														{preview.detail.agent_name.trim().slice(0, 1).toUpperCase() || "A"}
													</span>
													<h2>{preview.detail.agent_name}</h2>
													<p>请开始你的提问吧！</p>
												</div>
											) : (
												timelineItems.map((item) => (
													<div key={item.key} id={timelineDomId(item.key)} className="session-preview-timeline-item">
														<RunTimelineItemView item={item} />
													</div>
												))
											)}
											{showReplying && (
												<div className="case-msg agent">
													<div className="case-msg-bubble run-typing">
														<Loader2 className="spin" />
														<span>Agent 正在回复…</span>
													</div>
												</div>
											)}
										</>
									)}
								</div>
							</div>

							{preview.detail && (
								<PreviewComposer
									inputRef={inputRef}
									message={message}
									provider={preview.detail.provider}
									error={preview.error}
									busy={preview.busy}
									disabled={terminated}
									onMessageChange={setMessage}
									onSubmit={() => void submit()}
								/>
							)}
						</div>
						{preview.detail && (
							<SessionPreviewSidePanel
								detail={preview.detail}
								timelineItems={timelineItems}
								onLocate={locateTimelineItem}
								onResolveDeliveredFile={preview.resolveDeliveredFile}
							/>
						)}
					</div>
				</main>
			</div>
		</ArtifactAccessProvider>
	);
}

function timelineDomId(timelineKey: string): string {
	return `preview-item-${encodeURIComponent(timelineKey).replace(/%/g, "_")}`;
}

function PreviewComposer({
	inputRef,
	message,
	provider,
	error,
	busy,
	disabled,
	onMessageChange,
	onSubmit,
}: {
	inputRef: React.RefObject<HTMLTextAreaElement | null>;
	message: string;
	provider: string;
	error?: string;
	busy: boolean;
	disabled: boolean;
	onMessageChange(value: string): void;
	onSubmit(): void;
}) {
	useLayoutEffect(() => {
		const textarea = inputRef.current;
		if (!textarea) return;
		textarea.style.height = "0px";
		textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`;
	});

	const canSend = Boolean(message.trim()) && !busy && !disabled;

	return (
		<footer className="session-preview-composer">
			{error && (
				<div className="session-preview-composer-error">
					<CircleAlert />
					<span>{error}</span>
				</div>
			)}
			<div className="session-preview-composer-shell">
				<textarea
					ref={inputRef}
					rows={1}
					value={message}
					disabled={disabled}
					aria-label="继续输入指令"
					placeholder={disabled ? "Session 已终止" : "继续输入指令..."}
					onChange={(event) => onMessageChange(event.target.value)}
					onKeyDown={(event) => {
						if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
						event.preventDefault();
						if (canSend) onSubmit();
					}}
				/>
				<div className="session-preview-composer-footer">
					<div className="session-preview-runtime-pill">
						<Radio />
						<span>{provider}</span>
					</div>
					<span className="session-preview-composer-hint">Enter 发送 · Shift + Enter 换行</span>
					<button
						type="button"
						className={canSend ? "ready" : ""}
						aria-label={busy ? "Agent 正在回复" : "发送追问"}
						disabled={!canSend}
						onClick={onSubmit}
					>
						{busy ? <Loader2 className="spin" /> : <ArrowUp />}
					</button>
				</div>
			</div>
		</footer>
	);
}

function PreviewStatus({ status, streamState, busy }: { status?: string; streamState: string; busy: boolean }) {
	const label = busy ? (streamState === "reconnecting" ? "Reconnecting" : "Running") : (status ?? "Unknown");
	return (
		<span className={`session-preview-status ${busy ? "running" : (status ?? "unknown")}`}>
			{busy ? <Radio /> : <span />}
			{label}
		</span>
	);
}

function unavailableCopy(reason?: string): { title: string; body: string } {
	switch (reason) {
		case "not_found":
			return {
				title: "Session not found",
				body: "This Session ID is not registered to the current agents.yaml project.",
			};
		case "unrecoverable":
			return {
				title: "Session can no longer be recovered",
				body: "The remote Session was terminated or its pinned runtime is no longer available.",
			};
		case "server_unavailable":
			return {
				title: "Playground Server unavailable",
				body: "Restart the Playground for this project, then reload this Preview URL.",
			};
		default:
			return {
				title: "Session unavailable",
				body: "The Session could not be loaded from this project runtime.",
			};
	}
}
