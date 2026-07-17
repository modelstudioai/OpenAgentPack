import type { LucideIcon as LucideIconType } from "lucide-react";
import type { RunPhase } from "@/lib/view/run-phase";
import type { Task } from "../TaskBox";

export type { RunPhase };
export type LucideIcon = LucideIconType;
export type MobileTab = "product" | "chat";

export interface TaskRunModalProps {
	open: boolean;
	task: Task | null;
	onTaskUpdate: (task: Task) => void;
	onClose: () => void;
	onMakeSame?: (input: { prompt: string; agentId?: string }) => void;
}

export interface SendState {
	sending: boolean;
	error: string | null;
}
