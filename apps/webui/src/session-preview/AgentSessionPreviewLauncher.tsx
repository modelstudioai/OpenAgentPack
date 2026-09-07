import { ArrowLeft, Loader2, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { startSession } from "@/lib/project-api";
import { SessionPreviewPage } from "./SessionPreviewPage";
import "@/app/session-preview.css";

export function AgentSessionPreviewLauncher({ agentId }: { agentId: string }) {
	const [sessionId, setSessionId] = useState("");
	const [error, setError] = useState("");
	const [attempt, setAttempt] = useState(0);

	useEffect(() => {
		if (!agentId) {
			setError("The Preview URL does not contain a valid Agent ID.");
			return;
		}
		let cancelled = false;
		if (attempt > 0) setSessionId("");
		setError("");
		void startSession(agentId)
			.then((detail) => {
				if (cancelled) return;
				const createdSessionId = detail.session.session_id;
				window.history.replaceState(null, "", `/sessions/${encodeURIComponent(createdSessionId)}/preview`);
				setSessionId(createdSessionId);
			})
			.catch((createError) => {
				if (cancelled) return;
				setError(createError instanceof Error ? createError.message : String(createError));
			});
		return () => {
			cancelled = true;
		};
	}, [agentId, attempt]);

	if (sessionId) return <SessionPreviewPage sessionId={sessionId} />;

	return (
		<div className="session-preview">
			<header className="session-preview-header session-preview-launcher-header">
				<a className="session-preview-back" href="/" aria-label="Back to project workbench">
					<ArrowLeft />
				</a>
				<strong>Preview</strong>
			</header>
			<main className="session-preview-main">
				{error ? (
					<div className="session-preview-state error">
						<h2>Unable to create an empty Session</h2>
						<p>{error}</p>
						<div className="session-preview-launcher-actions">
							<a href="/">Return to project workbench</a>
							<button type="button" onClick={() => setAttempt((current) => current + 1)}>
								<RefreshCw />
								Retry
							</button>
						</div>
					</div>
				) : (
					<div className="session-preview-state">
						<Loader2 className="spin" />
						Creating an empty Session for {agentId}…
					</div>
				)}
			</main>
		</div>
	);
}
