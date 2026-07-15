/**
 * Badge data helpers for the Resource Center.
 * Each returns a { text, cls } pair consumed as <span className={`rc-badge ${cls}`}>{text}</span>.
 */

import { classifyFileScan } from "@openagentpack/sdk/scan-lifecycle";
import type {
	IdentityStamp,
	PlaybookResourceRow,
	ReferencedMcpRow,
	ReferencedSkillRow,
	ResourceFileRow,
	ResourceSkillRow,
} from "@/lib/domain/resource-center";

export const IDENTITY_LABEL: Record<IdentityStamp, string> = {
	playbook: "playbook",
	agents: "agents.*",
	none: "无戳",
};

/** Raw backend status → compact display badge. */
export function statusBadge(status?: string): { text: string; cls: string } {
	switch (status) {
		case "completed":
		case "idle":
			return { text: "完成", cls: "playbook" };
		case "failed":
			return { text: "失败", cls: "none" };
		case "terminated":
		case "deleted":
			return { text: "已取消", cls: "ghost" };
		default:
			return { text: status ? "运行中" : "—", cls: status ? "agents" : "ghost" };
	}
}

/** Uploaded-file scan status → badge. */
export function fileStatusBadge(row: ResourceFileRow): { text: string; cls: string } {
	if (row.available || classifyFileScan(row.status) === "ready") return { text: "可用", cls: "playbook" };
	switch (row.status) {
		case "rejected":
			return { text: "未通过", cls: "none" };
		case "type_rejected":
			return { text: "格式错误", cls: "none" };
		case "checking":
			return { text: "检测中", cls: "agents" };
		default:
			return { text: "扫描中", cls: "agents" };
	}
}

/** Custom-skill scan status → badge. */
export function skillStatusBadge(status: ResourceSkillRow["status"]): { text: string; cls: string; spin?: boolean } {
	switch (status) {
		case "active":
			return { text: "已生效", cls: "playbook" };
		case "rejected":
			return { text: "已拒绝", cls: "none" };
		case "deleted":
			return { text: "已删除", cls: "ghost" };
		default:
			return { text: "扫描中", cls: "agents", spin: true };
	}
}

export function referencedSkillBadge(status: ReferencedSkillRow["status"]): {
	text: string;
	cls: string;
	spin?: boolean;
} {
	switch (status) {
		case "active":
			return { text: "可用", cls: "playbook" };
		case "checking":
			return { text: "扫描中", cls: "agents", spin: true };
		case "rejected":
			return { text: "已拒绝", cls: "none" };
		case "deleted":
			return { text: "已删除", cls: "ghost" };
		case "missing":
			return { text: "未上传", cls: "none" };
		default:
			return { text: "已声明", cls: "ghost" };
	}
}

export function referencedMcpBadge(status: ReferencedMcpRow["status"]): { text: string; cls: string } {
	switch (status) {
		case "attached":
			return { text: "已挂载", cls: "playbook" };
		case "partial":
			return { text: "部分缺失", cls: "agents" };
		case "missing":
			return { text: "未挂载", cls: "none" };
		case "extra":
			return { text: "额外", cls: "agents" };
		default:
			return { text: "待创建", cls: "ghost" };
	}
}

export function playbookStatusBadge(status: PlaybookResourceRow["status"]): { text: string; cls: string } {
	switch (status) {
		case "ready":
			return { text: "可运行", cls: "playbook" };
		case "missing-agent":
			return { text: "待初始化", cls: "ghost" };
		case "degraded":
			return { text: "依赖异常", cls: "none" };
		default:
			return { text: "有漂移", cls: "agents" };
	}
}

export function relationBadge(status: "ready" | "none" | "pending" | "problem" | "drifted" | "missing" | "duplicate") {
	switch (status) {
		case "ready":
			return "playbook";
		case "none":
		case "pending":
		case "missing":
			return "ghost";
		case "duplicate":
		case "drifted":
			return "agents";
		default:
			return "none";
	}
}
