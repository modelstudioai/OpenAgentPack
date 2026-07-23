import { CalendarClock, CalendarDays, Check, Repeat2 } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createApiDeployment } from "@/lib/api/client";
import { type DeploymentPreset, deploymentPresetValue, toCron } from "@/lib/deployment";
import type { TopBarView } from "@/lib/topbar-route";

const presets = [
	{ label: "每天 9:00", icon: Repeat2, value: "daily" },
	{ label: "工作日 9:00", icon: CalendarDays, value: "weekdays" },
	{ label: "每周一 9:00", icon: CalendarDays, value: "weekly" },
] satisfies Array<{ label: string; icon: typeof CalendarDays; value: DeploymentPreset }>;

interface DeploymentButtonProps {
	/** Current prompt text from the composer input */
	prompt: string;
	/** Current active agent slug */
	agentId: string;
	/** Navigate to a top-bar view (used to jump to deployments after creation) */
	onNavigate?: (view: TopBarView) => void;
}

/** Derive a short name from the prompt (first line, capped at 20 chars). */
function autoName(prompt: string): string {
	const first = prompt.trim().split("\n")[0] ?? "";
	return first.length > 20 ? `${first.slice(0, 20)}…` : first;
}

export default function DeploymentButton({ prompt, agentId, onNavigate }: DeploymentButtonProps) {
	const uid = useId();
	const [open, setOpen] = useState(false);
	const [created, setCreated] = useState(false);
	const wrapRef = useRef<HTMLDivElement>(null);

	const [time, setTime] = useState(() => deploymentPresetValue("daily").time);
	const [repeat, setRepeat] = useState<string>(() => deploymentPresetValue("daily").repeat);
	const [busy, setBusy] = useState(false);
	const [message, setMessage] = useState<string | null>(null);

	// Close on outside click
	useEffect(() => {
		if (!open) return;
		const handler = (e: MouseEvent) => {
			if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
				setOpen(false);
			}
		};
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, [open]);

	const handleOpen = useCallback(() => {
		const value = deploymentPresetValue("daily");
		setTime(value.time);
		setRepeat(value.repeat);
		setMessage(null);
		setCreated(false);
		setOpen(true);
	}, []);

	const applyPreset = useCallback((preset: DeploymentPreset) => {
		const value = deploymentPresetValue(preset);
		setTime(value.time);
		setRepeat(value.repeat);
	}, []);

	const handleCreate = useCallback(async () => {
		const trimmedPrompt = prompt.trim();
		if (!trimmedPrompt || !agentId) {
			setMessage("请先在输入框中输入任务内容");
			return;
		}
		setBusy(true);
		setMessage(null);
		try {
			const expression = toCron(time, repeat);
			const result = await createApiDeployment({
				body: {
					name: autoName(trimmedPrompt),
					playbookId: agentId,
					prompt: trimmedPrompt,
					expression,
					timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai",
				},
			});
			if (result.error) {
				setMessage(result.error.error.message ?? "创建失败");
				return;
			}
			setCreated(true);
		} catch (error) {
			setMessage((error as Error).message ?? "创建失败");
		} finally {
			setBusy(false);
		}
	}, [prompt, agentId, time, repeat]);

	const timeId = `${uid}-time`;
	const repeatId = `${uid}-repeat`;

	return (
		<div className="deploy-menu-wrap" ref={wrapRef}>
			<button
				className={`deploy-trigger${open ? " active" : ""}`}
				type="button"
				aria-haspopup="dialog"
				aria-expanded={open}
				onClick={() => (open ? setOpen(false) : handleOpen())}
			>
				<CalendarClock size={17} strokeWidth={1.8} />
				<span>定时</span>
			</button>
			{open && (
				<div className="deploy-popover" role="dialog" aria-label="设置定时">
					{created ? (
						<div className="deploy-popover-success">
							<Check size={20} strokeWidth={2.5} />
							<span>定时任务已创建</span>
							<button
								type="button"
								className="deploy-popover-goto"
								onClick={() => {
									setOpen(false);
									onNavigate?.("deployments");
								}}
							>
								前往查看
							</button>
						</div>
					) : (
						<>
							<div className="deploy-popover-body">
								<div className="deploy-popover-presets">
									{presets.map((preset) => {
										const Icon = preset.icon;
										return (
											<button
												key={preset.value}
												type="button"
												className="deploy-preset"
												onClick={() => applyPreset(preset.value)}
											>
												<Icon size={14} />
												{preset.label}
											</button>
										);
									})}
								</div>

								<div className="deploy-popover-row">
									<div className="deploy-popover-field">
										<label htmlFor={timeId}>时间</label>
										<input id={timeId} type="datetime-local" value={time} onChange={(e) => setTime(e.target.value)} />
									</div>
									<div className="deploy-popover-field">
										<label htmlFor={repeatId}>重复</label>
										<select id={repeatId} value={repeat} onChange={(e) => setRepeat(e.target.value)}>
											<option value="每天">每天</option>
											<option value="工作日">工作日</option>
											<option value="每周">每周</option>
											<option value="每月">每月</option>
										</select>
									</div>
								</div>
							</div>

							{message && <p className="deploy-popover-message">{message}</p>}

							<div className="deploy-popover-footer">
								<button
									type="button"
									className="deploy-popover-submit"
									disabled={busy}
									onClick={() => void handleCreate()}
								>
									{busy ? "创建中…" : "创建定时"}
								</button>
							</div>
						</>
					)}
				</div>
			)}
		</div>
	);
}
