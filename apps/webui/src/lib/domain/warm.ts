import { warmApiSkill } from "../api/client";
import { confirmDialog } from "../confirm-dialog";
import { getVaultProfile, listPlaybooks, resolveSeedPlaybookSkills } from "../playbooks";
import { resolveActivePlaybookProvider } from "./config-api";
import { createBaseEnvironment, fetchEnvironments, findBaseEnvironment } from "./environment";
import { createBaseVault, fetchVaults, findBaseVault } from "./vault";

export interface WarmProgress {
	done: number;
	total: number;
}

type WarmTask = () => Promise<void>;

interface DistinctSkill {
	name: string;
	url: string;
}

// Union of url-declared custom skills across every published playbook, deduped by the
// provider-unique name so each distinct skill is uploaded exactly once (the seed shares
// one base skill across playbooks), making parallel warm race-free.
function collectDistinctSkills(provider: string): DistinctSkill[] {
	const byName = new Map<string, DistinctSkill>();
	for (const playbook of listPlaybooks(provider)) {
		for (const skill of resolveSeedPlaybookSkills(playbook.id, provider)) {
			if (!skill.url) continue;
			const name = skill.name ?? skill.skillId;
			if (!byName.has(name)) byName.set(name, { name, url: skill.url });
		}
	}
	return [...byName.values()];
}

async function resolveWarmPlaybookProvider(): Promise<string> {
	return resolveActivePlaybookProvider();
}

// Run every warm task in parallel against one shared N/M counter. total is the task
// count (each create / each distinct skill = 1). Best-effort: a task that throws is
// logged and still counts as done, so the banner always reaches total and hides.
export async function runWarmTasks(tasks: WarmTask[], onProgress: (p: WarmProgress) => void): Promise<void> {
	const total = tasks.length;
	let done = 0;
	onProgress({ done, total });
	if (total === 0) return;
	await Promise.all(
		tasks.map(async (task) => {
			try {
				await task();
			} catch (error) {
				console.warn("[warm] 预热任务失败,将在首次点击/会话创建时懒补。", error);
			}
			done += 1;
			onProgress({ done, total });
		}),
	);
}

// Plan the create tasks for the two resources a session needs: a cloud sandbox (Agents/base,
// always required) and — only when the provider defines a vault profile — a credential vault
// (Agents/secrets). Bailian needs the vault (DASHSCOPE_API_KEY); other providers currently don't.
// Returns [] if both already exist or the user declines.
async function planBaseResourceTasks(provider: string): Promise<WarmTask[]> {
	const needsVault = !!getVaultProfile(provider);
	const [environments, vaults] = await Promise.all([
		fetchEnvironments(),
		needsVault ? fetchVaults() : Promise.resolve([]),
	]);
	const hasEnv = !!findBaseEnvironment(environments);
	const hasVault = !needsVault || !!findBaseVault(vaults);
	if (hasEnv && hasVault) return [];

	const ok = await confirmDialog({
		title: "未检测到基础资源",
		message: "任务需要云端运行环境(沙箱)与密钥库才能执行。是否创建默认「Agents/base」+「Agents/secrets」?",
		confirmText: "创建",
		cancelText: "稍后",
	});
	if (!ok) return [];
	const tasks: WarmTask[] = [];
	if (!hasEnv) tasks.push(() => createBaseEnvironment());
	if (!hasVault) tasks.push(() => createBaseVault().then(() => undefined));
	return tasks;
}

// Single app-entry warm orchestrator: provision the cold-workspace base resources
// (sandbox Agents/base + vault Agents/secrets) and pre-upload each distinct seed custom
// skill, under one shared N/M progress banner. Non-blocking/best-effort — the hard gate
// is at session create, where resolveBase*Id throws on a still-missing resource.
export async function warmWorkspace(onProgress: (p: WarmProgress) => void): Promise<void> {
	try {
		const provider = await resolveWarmPlaybookProvider();
		const baseTasks = await planBaseResourceTasks(provider);
		const skillTasks: WarmTask[] = collectDistinctSkills(provider).map((skill) => async () => {
			const res = await warmApiSkill({ body: skill });
			if (res.error) console.warn(`预热技能「${skill.name}」失败,将在首次点击时懒创建。`, res.error);
		});
		await runWarmTasks([...baseTasks, ...skillTasks], onProgress);
	} catch (error) {
		console.error("[warm] workspace warm failed:", error);
	}
}
