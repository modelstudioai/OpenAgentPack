export type DeploymentPreset = "daily" | "weekdays" | "weekly";

export interface DeploymentPresetValue {
	time: string;
	repeat: "每天" | "工作日" | "每周";
}

export function localDateTime(date: Date): string {
	return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function deploymentPresetValue(preset: DeploymentPreset, now = new Date()): DeploymentPresetValue {
	const date = new Date(now);
	date.setHours(9, 0, 0, 0);
	if (preset === "weekly") {
		const daysUntilMonday = (8 - date.getDay()) % 7 || 7;
		date.setDate(date.getDate() + daysUntilMonday);
		return { time: localDateTime(date), repeat: "每周" };
	}
	return { time: localDateTime(date), repeat: preset === "weekdays" ? "工作日" : "每天" };
}

export function toCron(value: string, repeat: string): string {
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) throw new Error("请选择有效的执行时间");
	const prefix = `${date.getMinutes()} ${date.getHours()}`;
	if (repeat === "工作日") return `${prefix} * * 1-5`;
	if (repeat === "每周") return `${prefix} * * ${date.getDay()}`;
	if (repeat === "每月") return `${prefix} ${date.getDate()} * *`;
	return `${prefix} * * *`;
}

export function cronLabel(expression: string): string {
	const [minute, hour, day, , weekday] = expression.split(" ");
	const time = `${hour?.padStart(2, "0")}:${minute?.padStart(2, "0")}`;
	if (weekday === "1-5") return `工作日 ${time}`;
	if (weekday && weekday !== "*") return `每周 ${time}`;
	if (day && day !== "*") return `每月 ${day} 日 ${time}`;
	return `每天 ${time}`;
}
