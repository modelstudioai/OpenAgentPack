import { Database, KeyRound, MessageSquare, Package, RefreshCw, Server } from "lucide-react";
import { useState } from "react";
import { ResourceCenterProvider, useRc } from "./context";
import { LibraryPanel } from "./panels/LibraryPanel";
import { RuntimePanel } from "./panels/RuntimePanel";
import { SessionsPanel } from "./panels/SessionsPanel";
import { TopologyPanel } from "./panels/TopologyPanel";

type ResourceTab = "topology" | "library" | "runtime" | "sessions";

export default function ResourceCenter() {
	return (
		<ResourceCenterProvider>
			<ResourceCenterBody />
		</ResourceCenterProvider>
	);
}

function ResourceCenterBody() {
	const { view, loading, error, topology, refresh } = useRc();
	const [resourceTab, setResourceTab] = useState<ResourceTab>("topology");

	const baseEnv = view?.environments?.[0];
	const baseVault = view?.vaults?.[0];

	return (
		<main className="rc-main">
			<section className="rc-page-head">
				<div>
					<div className="rc-kicker">
						<Database size={14} aria-hidden="true" />
						云端资源账本
					</div>
					<h1>资源中心 · 项目资源账本</h1>
					<p>
						Agent 与会话按当前应用身份戳收口，文件按 <code>Agents__</code> 前缀隔离，运行环境与密钥库展示 WebUI 管理的
						base 资源；Skill 与 MCP 作为当前玩法引用资源单独核对。
					</p>
				</div>
				<button className="pill-btn" type="button" onClick={refresh} disabled={loading}>
					<RefreshCw size={15} aria-hidden="true" className={loading ? "rc-spin" : undefined} />
					{loading ? "刷新中…" : "刷新"}
				</button>
			</section>

			{error ? <div className="rc-alert warn">{error}</div> : null}

			<section className="rc-summary" aria-label="概览">
				<div className="rc-metric">
					<div className="rc-metric-label">
						<Database size={14} aria-hidden="true" />
						可运行场景
					</div>
					<div className="rc-metric-main">
						<span className="rc-metric-value">
							{topology ? `${topology.summary.readyPlaybooks}/${topology.summary.playbookTotal}` : "—"}
						</span>
						<span className="rc-metric-note">按场景资源链路判断</span>
					</div>
				</div>
				<div className="rc-metric">
					<div className="rc-metric-label">
						<Database size={14} aria-hidden="true" />
						异常场景
					</div>
					<div className="rc-metric-main">
						<span className={`rc-metric-value${topology?.summary.problemPlaybooks ? " warn" : ""}`}>
							{topology ? topology.summary.problemPlaybooks : "—"}
						</span>
						<span className="rc-metric-note">缺失、漂移或依赖异常</span>
					</div>
				</div>
				<div className="rc-metric">
					<div className="rc-metric-label">
						<Database size={14} aria-hidden="true" />
						缺失 Agent
					</div>
					<div className="rc-metric-main">
						<span className={`rc-metric-value${topology?.summary.missingAgentPlaybooks ? " warn" : ""}`}>
							{topology ? topology.summary.missingAgentPlaybooks : "—"}
						</span>
						<span className="rc-metric-note">本地有玩法，云端未创建</span>
					</div>
				</div>
				<div className="rc-metric">
					<div className="rc-metric-label">
						<Package size={14} aria-hidden="true" />
						Skill 问题
					</div>
					<div className="rc-metric-main">
						<span className={`rc-metric-value${topology?.summary.skillProblemPlaybooks ? " warn" : ""}`}>
							{topology ? topology.summary.skillProblemPlaybooks : "—"}
						</span>
						<span className="rc-metric-note">缺失、拒绝或未完成扫描</span>
					</div>
				</div>
				<div className="rc-metric">
					<div className="rc-metric-label">
						<Server size={14} aria-hidden="true" />
						MCP 漂移
					</div>
					<div className="rc-metric-main">
						<span className={`rc-metric-value${topology?.summary.mcpDriftPlaybooks ? " warn" : ""}`}>
							{topology ? topology.summary.mcpDriftPlaybooks : "—"}
						</span>
						<span className="rc-metric-note">声明与 Agent 挂载不一致</span>
					</div>
				</div>
				<div className="rc-metric">
					<div className="rc-metric-label">
						<MessageSquare size={14} aria-hidden="true" />
						会话
					</div>
					<div className="rc-metric-main">
						<span className="rc-metric-value">{topology ? topology.summary.totalSessions : "—"}</span>
						<span className="rc-metric-note">按当前应用 Agent 收口</span>
					</div>
				</div>
				<div className="rc-metric">
					<div className="rc-metric-label">
						<KeyRound size={14} aria-hidden="true" />
						运行底座
					</div>
					<div className="rc-metric-main">
						<span className="rc-metric-value">
							{topology ? Number(topology.runtime.hasBaseEnvironment) + Number(topology.runtime.hasBaseVault) : "—"}
						</span>
						<span className="rc-metric-note">Env / Vault 就绪项</span>
					</div>
				</div>
			</section>

			<section className="rc-alerts" aria-label="告警">
				{!loading && view && view.agents.length === 0 && !baseEnv && !baseVault ? (
					<div className="rc-alert info">
						<span className="tag">初始化</span>
						<span className="grow">
							尚未检测到本项目的云端资源。创建首个任务时会自动引导完成初始化(Agent、运行沙箱,以及控制台模式所需的密钥库)。
						</span>
					</div>
				) : null}
				{view && view.duplicateNames.length > 0 ? (
					<div className="rc-alert warn">
						<span className="tag">重复</span>
						<span className="grow">
							{view.duplicateNames.length} 组同名 Agent：<b>{view.duplicateNames.join("、")}</b>。任务历史被劈裂到不同
							id 上。
						</span>
					</div>
				) : null}
				{view && view.metrics.orphanCount > 0 ? (
					<div className="rc-alert warn">
						<span className="tag">身份戳漂移</span>
						<span className="grow">
							{view.metrics.orphanCount} 个 Agent 缺少当前应用玩法戳（多为 <code>agents.project / agents.resource</code>
							，疑似
							<code>bl</code> 部署创建），webui 无法按当前应用玩法识别。
						</span>
					</div>
				) : null}
				{view && view.missing.length > 0 ? (
					<div className="rc-alert info">
						<span className="tag">缺失</span>
						<span className="grow">
							本地有「{view.missing.map((s) => s.playbookName).join(" / ")}」玩法，但云端尚未创建对应 Agent
							（首次使用时懒创建，非错误）。
						</span>
					</div>
				) : null}
			</section>

			<section className="rc-body">
				<nav className="rc-tabs" aria-label="资源中心视图">
					<button
						className={`pill-control${resourceTab === "topology" ? " active" : ""}`}
						type="button"
						onClick={() => setResourceTab("topology")}
					>
						场景拓扑
					</button>
					<button
						className={`pill-control${resourceTab === "library" ? " active" : ""}`}
						type="button"
						onClick={() => setResourceTab("library")}
					>
						资源库
					</button>
					<button
						className={`pill-control${resourceTab === "runtime" ? " active" : ""}`}
						type="button"
						onClick={() => setResourceTab("runtime")}
					>
						运行底座
					</button>
					<button
						className={`pill-control${resourceTab === "sessions" ? " active" : ""}`}
						type="button"
						onClick={() => setResourceTab("sessions")}
					>
						全部会话
					</button>
				</nav>

				{resourceTab === "topology" ? <TopologyPanel /> : null}
				{resourceTab === "sessions" ? <SessionsPanel /> : null}
				{resourceTab === "library" ? <LibraryPanel /> : null}
				{resourceTab === "runtime" ? <RuntimePanel /> : null}
			</section>

			<div className="rc-foot-note">
				数据源：<code>listAgents</code>（列表即返完整字段）+ 按每个 Agents <code>agent.id</code> 收口的{" "}
				<code>listSessions</code> + 组织级 <code>listEnvironments</code>。 经 server REST 拉取自 OpenAPI。
			</div>
		</main>
	);
}
