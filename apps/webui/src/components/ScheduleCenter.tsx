import { CalendarDays, CheckCircle2, Clock3, PauseCircle, PlayCircle, Plus, Repeat2, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	createApiDeployment,
	deleteApiDeployment,
	listApiDeployments,
	type ManagedDeployment,
	runApiDeployment,
	setApiDeploymentPaused,
} from "@/lib/api/client";
import { getRoleCards } from "@/lib/playbooks";
import type { RoleCard } from "@/lib/playbooks/types";
import { cronLabel, type SchedulePreset, schedulePresetValue, toCron } from "@/lib/schedule";

const presets = [
	{ label: "每天 9:00", icon: Repeat2, value: "daily" },
	{ label: "工作日 9:00", icon: CalendarDays, value: "weekdays" },
	{ label: "每周一 9:00", icon: CalendarDays, value: "weekly" },
] satisfies Array<{ label: string; icon: typeof CalendarDays; value: SchedulePreset }>;

interface ScheduleCenterProps {
	draft?: { key: number; preset?: SchedulePreset; prompt: string; playbookId: string };
}

export default function ScheduleCenter({ draft }: ScheduleCenterProps) {
	const defaultSchedule = useMemo(() => schedulePresetValue("daily"), []);
	const [items, setItems] = useState<ManagedDeployment[]>([]);
	const [roles, setRoles] = useState<RoleCard[]>([]);
	const [name, setName] = useState("");
	const [prompt, setPrompt] = useState("");
	const [playbookId, setPlaybookId] = useState("");
	const [time, setTime] = useState(defaultSchedule.time);
	const [repeat, setRepeat] = useState<string>(defaultSchedule.repeat);
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
		void getRoleCards().then((cards) => {
			setRoles(cards);
			setPlaybookId((current) => current || cards[0]?.slug || "");
		});
	}, [reload]);

	useEffect(() => {
		if (!draft?.key) return;
		setPrompt(draft.prompt);
		if (draft.playbookId) setPlaybookId(draft.playbookId);
		if (draft.preset) {
			const value = schedulePresetValue(draft.preset);
			setTime(value.time);
			setRepeat(value.repeat);
		}
	}, [draft]);

	async function create() {
		if (!name.trim() || !prompt.trim() || !playbookId) return setMessage("请填写名称、任务内容并选择执行角色");
		setBusy("create");
		setMessage(null);
		let expression: string;
		try {
			expression = toCron(time, repeat);
		} catch (error) {
			setBusy(null);
			return setMessage((error as Error).message);
		}
		const result = await createApiDeployment({
			body: {
				name: name.trim(),
				playbookId,
				prompt: prompt.trim(),
				expression,
				timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai",
			},
		});
		setBusy(null);
		if (result.error) return setMessage(result.error.error.message ?? "创建失败");
		setName("");
		setPrompt("");
		setMessage("已创建并同步到真实 deployment 服务");
		await reload();
	}

	async function mutate(
		id: string,
		operation: () => Promise<{ error?: { error: { message?: string } } }>,
		success: string,
	) {
		setBusy(id);
		setMessage(null);
		const result = await operation();
		setBusy(null);
		if (result.error) return setMessage(result.error.error.message ?? "操作失败");
		setMessage(success);
		await reload();
	}

	return (
		<main className="schedule-page" aria-labelledby="schedule-title">
			<section className="schedule-hero">
				<div>
					<p className="schedule-kicker">真实服务自动执行</p>
					<h1 id="schedule-title">定时</h1>
					<p className="schedule-subtitle">通过 OpenCMA server 创建 Qoder / Claude 原生 Deployment，到点自动运行。</p>
				</div>
				<button className="schedule-create-btn" type="button" disabled={busy !== null} onClick={() => void create()}>
					<Plus size={18} />
					{busy === "create" ? "创建中…" : "新建定时"}
				</button>
			</section>
			{message && (
				<p role="status" className="schedule-feedback">
					{message}
				</p>
			)}
			<section className="schedule-builder" aria-label="创建定时任务">
				<div className="builder-grid">
					<div className="builder-field">
						<label htmlFor="schedule-name">计划名称</label>
						<input
							id="schedule-name"
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder="每日增长数据复盘"
						/>
					</div>
					<div className="builder-field">
						<label htmlFor="schedule-agent">执行角色</label>
						<select id="schedule-agent" value={playbookId} onChange={(e) => setPlaybookId(e.target.value)}>
							{roles.map((role) => (
								<option key={role.slug} value={role.slug}>
									{role.name}
								</option>
							))}
						</select>
					</div>
				</div>
				<div className="builder-field prompt-field">
					<label htmlFor="schedule-prompt">任务内容</label>
					<textarea
						id="schedule-prompt"
						value={prompt}
						onChange={(e) => setPrompt(e.target.value)}
						placeholder="例如：整理昨日销售数据，并给出3条运营建议"
					/>
				</div>
				<div className="builder-grid">
					<div className="builder-field">
						<label htmlFor="schedule-time">执行时间</label>
						<input id="schedule-time" type="datetime-local" value={time} onChange={(e) => setTime(e.target.value)} />
					</div>
					<div className="builder-field">
						<label htmlFor="schedule-repeat">重复</label>
						<select id="schedule-repeat" value={repeat} onChange={(e) => setRepeat(e.target.value)}>
							<option>每天</option>
							<option>工作日</option>
							<option>每周</option>
							<option>每月</option>
						</select>
					</div>
				</div>
				<div className="schedule-preset-row">
					{presets.map((preset) => {
						const Icon = preset.icon;
						return (
							<button
								key={preset.label}
								type="button"
								className="schedule-preset"
								onClick={() => {
									const value = schedulePresetValue(preset.value);
									setTime(value.time);
									setRepeat(value.repeat);
								}}
							>
								<Icon size={16} />
								{preset.label}
							</button>
						);
					})}
				</div>
			</section>
			<section className="schedule-list" aria-label="定时列表">
				<div className="schedule-list-head">
					<h2>已创建</h2>
					<span>{items.length} 个计划</span>
				</div>
				<div className="schedule-table">
					{busy === "load" && items.length === 0 && <p className="schedule-empty">正在从服务端加载…</p>}
					{busy !== "load" && items.length === 0 && (
						<p className="schedule-empty">暂无计划。创建后会直接同步到当前 Qoder / Claude provider。</p>
					)}
					{items.map((item) => {
						const paused = item.status.toLowerCase().includes("pause");
						return (
							<article key={item.id} className="schedule-row">
								<div className="schedule-row-main">
									<div className="schedule-row-title">
										{paused ? <PauseCircle size={17} /> : <CheckCircle2 size={17} />}
										<h3>{item.name}</h3>
									</div>
									<p>{item.prompt}</p>
								</div>
								<div className="schedule-meta">
									<span>{roles.find((r) => r.slug === item.playbookId)?.name ?? item.playbookId}</span>
									<span>{cronLabel(item.schedule.expression)}</span>
									<span>
										{item.provider} · {item.status}
									</span>
								</div>
								<div className="schedule-actions">
									<button
										type="button"
										disabled={busy === item.id}
										aria-label={paused ? "启用" : "暂停"}
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
										disabled={busy === item.id}
										aria-label="立即运行"
										onClick={() =>
											void mutate(item.id, () => runApiDeployment({ path: { id: item.id } }), "已触发运行")
										}
									>
										<Clock3 size={18} />
									</button>
									<button
										type="button"
										disabled={busy === item.id}
										aria-label="删除"
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
