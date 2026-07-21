import { CalendarClock, CalendarDays, Repeat } from "lucide-react";
import { useState } from "react";
import type { SchedulePreset } from "@/lib/schedule";

interface ScheduleButtonProps {
	onOpenSchedule?: (preset?: SchedulePreset) => void;
}

const quickOptions = [
	{ icon: Repeat, label: "每天 9:00", value: "daily" },
	{ icon: CalendarDays, label: "工作日 9:00", value: "weekdays" },
	{ icon: CalendarClock, label: "每周一 9:00", value: "weekly" },
] satisfies Array<{ icon: typeof CalendarClock; label: string; value: SchedulePreset }>;

export default function ScheduleButton({ onOpenSchedule }: ScheduleButtonProps) {
	const [open, setOpen] = useState(false);

	const chooseQuickOption = (preset: SchedulePreset) => {
		setOpen(false);
		onOpenSchedule?.(preset);
	};

	return (
		<div className="schedule-menu-wrap">
			<button
				className={`schedule-trigger${open ? " active" : ""}`}
				type="button"
				aria-haspopup="menu"
				aria-expanded={open}
				onClick={() => setOpen((next) => !next)}
			>
				<CalendarClock size={17} strokeWidth={1.8} />
				<span>定时</span>
			</button>
			{open ? (
				<div className="schedule-menu" role="menu">
					<button
						className="schedule-menu-primary"
						type="button"
						role="menuitem"
						onClick={() => {
							setOpen(false);
							onOpenSchedule?.();
						}}
					>
						<CalendarClock size={20} strokeWidth={1.8} />
						<span>定时执行</span>
					</button>
					<div className="schedule-menu-divider" />
					{quickOptions.map((option) => {
						const Icon = option.icon;
						return (
							<button
								key={option.value}
								className="schedule-menu-item"
								type="button"
								role="menuitem"
								onClick={() => chooseQuickOption(option.value)}
							>
								<Icon size={19} strokeWidth={1.8} />
								<span>{option.label}</span>
							</button>
						);
					})}
				</div>
			) : null}
		</div>
	);
}
