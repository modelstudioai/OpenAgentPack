import { CheckCircle2, PauseCircle, Play, PlayCircle, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
	deleteApiDeployment,
	listApiDeployments,
	type ManagedDeployment,
	runApiDeployment,
	setApiDeploymentPaused,
} from "@/lib/api/client";
import { cronLabel } from "@/lib/deployment";
import { getRoleCards } from "@/lib/playbooks";
import type { RoleCard } from "@/lib/playbooks/types";

export default function DeploymentCenter() {
	const [items, setItems] = useState<ManagedDeployment[]>([]);
	const [roles, setRoles] = useState<RoleCard[]>([]);
	const [busy, setBusy] = useState<string | null>("load");
	const [message, setMessage] = useState<string | null>(null);

	const reload = useCallback(async () => {
		setBusy("load");
		const result = await listApiDeployments();
		setBusy(null);
		if (result.error) return setMessage(result.error.error.message ?? "加载定时任务失败");
		setItems(result.data?.deployments ?? []);
	}, []);

	useEffect(() => {
		void reload();
		void getRoleCards().then(setRoles);
	}, [reload]);

	async function mutate(
		id: string,
		operation: () => Promise<{ error?: { error: { message?: string } } }>,
		success: string,
	) {
		setBusy(id);
		setMessage(null);
		try {
			const result = await operation();
			if (result.error) return setMessage(result.error.error.message ?? "操作失败");
			setMessage(success);
			await reload();
		} catch (error) {
			setMessage((error as Error).message ?? "操作失败");
		} finally {
			setBusy(null);
		}
	}

	return (
		<main className="deploy-page" aria-labelledby="deploy-title">
			<section className="deploy-hero">
				<div>
					<p className="deploy-kicker">定时任务管理</p>
					<h1 id="deploy-title">定时</h1>
					<p className="deploy-subtitle">
						查看和管理已创建的定时任务。要创建新定时任务，请在输入框中输入任务内容后点击「定时」按钮。
					</p>
				</div>
			</section>
			{message && (
				<p role="status" className="deploy-feedback">
					{message}
				</p>
			)}
			<section className="deploy-list" aria-label="定时列表">
				<div className="deploy-list-head">
					<h2>已创建</h2>
					<span>{items.length} 个计划</span>
				</div>
				<div className="deploy-table">
					{busy === "load" && items.length === 0 && <p className="deploy-empty">正在从服务端加载…</p>}
					{busy !== "load" && items.length === 0 && (
						<p className="deploy-empty">暂无计划。在输入框中输入任务内容后，点击「定时」按钮即可创建。</p>
					)}
					{items.map((item) => {
						const paused = item.status.toLowerCase().includes("pause");
						return (
							<article key={item.id} className="deploy-row">
								<div className="deploy-row-main">
									<div className="deploy-row-title">
										{paused ? <PauseCircle size={17} /> : <CheckCircle2 size={17} />}
										<h3>{item.name}</h3>
									</div>
									<p>{item.prompt}</p>
								</div>
								<div className="deploy-meta">
									<span>{roles.find((r) => r.slug === item.playbookId)?.name ?? item.playbookId}</span>
									<span>{cronLabel(item.schedule.expression)}</span>
									<span>
										{item.provider} · {item.status}
									</span>
								</div>
								<div className="deploy-actions">
									<button
										type="button"
										disabled={busy === item.id}
										aria-label={paused ? "启用" : "暂停"}
										title={paused ? "恢复定时执行" : "暂停定时执行"}
										onClick={() =>
											void mutate(
												item.id,
												() => setApiDeploymentPaused({ path: { id: item.id }, body: { paused: !paused } }),
												paused ? "已启用" : "已暂停",
											)
										}
									>
										{paused ? <PlayCircle size={18} /> : <PauseCircle size={18} />}
									</button>
									<button
										type="button"
										className="deploy-action-run"
										disabled={busy === item.id}
										aria-label="立即运行"
										title="手动执行一次，验证任务是否正常"
										onClick={() =>
											void mutate(item.id, () => runApiDeployment({ path: { id: item.id } }), "已触发运行")
										}
									>
										<Play size={15} />
										<span>运行</span>
									</button>
									<button
										type="button"
										disabled={busy === item.id}
										aria-label="删除"
										title="删除此定时任务"
										onClick={() => {
											if (window.confirm(`确定删除「${item.name}」吗？`))
												void mutate(item.id, () => deleteApiDeployment({ path: { id: item.id } }), "已删除");
										}}
									>
										<Trash2 size={18} />
									</button>
								</div>
							</article>
						);
					})}
				</div>
			</section>
		</main>
	);
}
