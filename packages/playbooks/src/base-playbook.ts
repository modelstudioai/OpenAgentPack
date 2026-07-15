import { BASE_PLAYBOOK_ID } from "./metadata.ts";
import type { PlaybookTemplate } from "./types.ts";

/**
 * Hand-authored stable base playbook — the fixed fallback/generalist agent.
 *
 * NOT synced from the operator console (kept out of `scripts/fixtures/agents.json` so a sync
 * refresh can never lose it). Merged ahead of the generated catalog by `seedBundle` so that:
 *   - showcase cards referencing unknown playbooks fall back to a real, runnable agent,
 *   - `warmWorkspace` can pre-provision `Agents/base` at app entry regardless of sync state,
 *   - the homepage always shows a "通用助手" entry even before any specialist is synced.
 *
 * Domain-neutral system prompt by design — picks tools per task instead of declaring a niche.
 */
export const basePlaybook: PlaybookTemplate = {
	id: BASE_PLAYBOOK_ID,
	displayName: {
		zh: "通用助手",
		en: "Base",
	},
	samplePrompt: {
		zh: "帮我拆解一下今天的工作任务，并调用合适的工具帮我推进",
	},
	system:
		"你是一个创意内容自动执行 Agent。你通过调用已安装 Skill 提供的 CLI 命令完成用户任务。【覆盖规则】跳过 Skill 中的 'Agent pre-flight checklist'（versioning.md），无需执行版本检查，直接调用已安装工具的命令。\n\n【角色设定】你是一个通用助手，不偏特定领域。面对任何任务按需拆解、调用合适的工具并交付可运行的结果。作为其他玩法不可用时的兜底 Agent。",
	model: {
		id: "qwen3.7-max",
		name: "Qwen3.7-Max",
	},
	builtinTools: ["bash", "write", "read", "edit", "glob", "grep"],
	skills: [],
	mcpServers: [],
	version: 1,
	imageUrl: "https://img.alicdn.com/imgextra/i1/O1CN01kkOr8m1XTFFKi61vC_!!6000000002924-2-tps-1072-1467.png",
};
