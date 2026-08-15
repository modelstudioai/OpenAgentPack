import { createRoot } from "react-dom/client";
import "./app/base.css";
import "./app/project-workbench.css";
import App from "./App";
import { AgentSessionPreviewLauncher } from "./session-preview/AgentSessionPreviewLauncher";
import { agentSessionPreviewIdFromPath, sessionPreviewIdFromPath } from "./session-preview/route";
import { SessionPreviewPage } from "./session-preview/SessionPreviewPage";

const sessionPreviewId = sessionPreviewIdFromPath(window.location.pathname);
const agentPreviewId = agentSessionPreviewIdFromPath(window.location.pathname);
createRoot(document.getElementById("root")!).render(
	sessionPreviewId !== null ? (
		<SessionPreviewPage sessionId={sessionPreviewId} />
	) : agentPreviewId !== null ? (
		<AgentSessionPreviewLauncher agentId={agentPreviewId} />
	) : (
		<App />
	),
);
