import { FileText, Image as ImageIcon, LayoutGrid, Video } from "lucide-react";
import type { LucideIcon } from "./types";

/** 任务类型对应的图标 */
export const typeIcons = {
	text: FileText,
	video: Video,
	image: ImageIcon,
	app: LayoutGrid,
} as const satisfies Record<string, LucideIcon>;
