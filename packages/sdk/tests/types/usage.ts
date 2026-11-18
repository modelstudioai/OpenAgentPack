import type { UsageSummaryRequest, UsageTrendRequest } from "../../src/index.ts";

const time_range = { start_time: "2026-11-02T10:00:00+08:00", end_time: "2026-11-02T15:00:00+08:00" };

const workspace: UsageSummaryRequest = { dimension: "workspace", time_range };
const agent: UsageSummaryRequest = { dimension: "agent", agent_id: "agent_one", time_range };
const session: UsageSummaryRequest = { dimension: "session", session_id: "sesn_one" };
const trend: UsageTrendRequest = { dimension: "agent", agent_id: "agent_one", time_range };

// @ts-expect-error the agent branch requires agent_id
const missingAgentId: UsageSummaryRequest = { dimension: "agent", time_range };
// @ts-expect-error the session branch forbids time_range
const sessionWithRange: UsageSummaryRequest = { dimension: "session", session_id: "sesn_one", time_range };
// @ts-expect-error the workspace branch forbids agent_id
const workspaceWithAgent: UsageSummaryRequest = { dimension: "workspace", time_range, agent_id: "agent_one" };
// @ts-expect-error trend queries have no session dimension
const sessionTrend: UsageTrendRequest = { dimension: "session", session_id: "sesn_one" };

void [workspace, agent, session, trend, missingAgentId, sessionWithRange, workspaceWithAgent, sessionTrend];
