import { resolveAgentRefs } from "../../src/internal/executor/resolver.ts";
import { BailianAdapter } from "../../src/internal/providers/bailian/adapter.ts";
import { StateManager } from "../../src/internal/state/state-manager.ts";
import type { ProjectConfig } from "../../src/internal/types/config.ts";

const API_KEY = process.env.DASHSCOPE_API_KEY;
// Optional override; when unset the adapter derives production from workspace_id.
const BASE_URL = process.env.BAILIAN_BASE_URL?.trim() || undefined;
const WORKSPACE_ID = process.env.BAILIAN_WORKSPACE_ID ?? "llm-us9hjmt32nysdm5v";
const OFFICIAL_SKILL_CODE = process.env.BAILIAN_OFFICIAL_SKILL_CODE ?? "pptx";
const OFFICIAL_SKILL_VERSION = process.env.BAILIAN_OFFICIAL_SKILL_VERSION ?? "1.0";

if (!API_KEY) {
	console.log("⏭  DASHSCOPE_API_KEY not set, skipping Bailian official skill live test");
	process.exit(0);
}

type SkillListItem = {
	id?: string | number;
	skill_id?: string;
	code?: string;
	name?: string;
	version?: string;
	latest_version?: string;
};

const projectName = "agents-official-skill-live";
const adapter = new BailianAdapter(API_KEY, WORKSPACE_ID, BASE_URL, projectName);
let createdAgentId: string | undefined;

function dedupe(values: Array<string | undefined>): string[] {
	return Array.from(new Set(values.filter((v): v is string => Boolean(v))));
}

async function officialSkillCandidates(): Promise<Array<{ skill_id: string; version: string }>> {
	const envSkillId = process.env.BAILIAN_OFFICIAL_SKILL_ID;
	const candidates: Array<{ skill_id: string; version: string }> = [];
	if (envSkillId) {
		candidates.push({ skill_id: envSkillId, version: OFFICIAL_SKILL_VERSION });
	}

	try {
		const res = await fetch(`${BASE_URL}/skills?source=official&limit=100`, {
			headers: { Authorization: `Bearer ${API_KEY}` },
		});
		if (res.ok) {
			const body = (await res.json()) as { data?: SkillListItem[] };
			const match = (body.data ?? []).find(
				(s) =>
					s.code === OFFICIAL_SKILL_CODE ||
					s.name === OFFICIAL_SKILL_CODE ||
					s.skill_id === OFFICIAL_SKILL_CODE ||
					String(s.id) === OFFICIAL_SKILL_CODE,
			);
			if (match) {
				const version = match.version ?? match.latest_version ?? OFFICIAL_SKILL_VERSION;
				for (const skill_id of dedupe([
					match.skill_id,
					match.code,
					match.name,
					typeof match.id === "string" ? match.id : undefined,
				])) {
					candidates.push({ skill_id, version });
				}
			}
		} else {
			console.log(`   ⚠  official skill list returned ${res.status}; falling back to code`);
		}
	} catch (err) {
		console.log(`   ⚠  official skill list failed: ${err instanceof Error ? err.message : String(err)}`);
	}

	candidates.push({ skill_id: OFFICIAL_SKILL_CODE, version: OFFICIAL_SKILL_VERSION });
	return dedupe(candidates.map((c) => `${c.skill_id}@${c.version}`)).map((raw) => {
		const [skill_id, version] = raw.split("@");
		return { skill_id: skill_id!, version: version! };
	});
}

async function run() {
	console.log("=== Bailian Official Skill Live E2E ===\n");

	console.log("1. validate()...");
	await adapter.validate();
	console.log("   ✅ validate passed\n");

	const candidates = await officialSkillCandidates();
	console.log(`2. official skill candidates: ${candidates.map((c) => `${c.skill_id}@${c.version}`).join(", ")}\n`);

	let lastError: unknown;
	for (const candidate of candidates) {
		const name = `agents-official-pptx-${Date.now()}`;
		const config: ProjectConfig = {
			version: "1",
			providers: { bailian: {} },
			agents: {
				[name]: {
					model: "qwen3.7-max",
					instructions: "You are an official skill binding test agent.",
					description: "Agents live test for Bailian official pptx skill",
					skills: [
						{
							type: "official",
							skill_id: candidate.skill_id,
							version: candidate.version,
						},
					],
				},
			},
		};
		const refs = resolveAgentRefs(
			name,
			config,
			"bailian",
			StateManager.initialize("/tmp/agents-official-skill-live.json"),
		);

		try {
			console.log(`3. createAgent() with ${candidate.skill_id}@${candidate.version}...`);
			const agent = await adapter.createAgent(name, config.agents![name]!, refs);
			createdAgentId = agent.id!;
			console.log(`   ✅ created agent: ${agent.id} (version=${agent.version})\n`);
			console.log("=== Official skill live test passed! ===");
			return;
		} catch (err) {
			lastError = err;
			console.log(`   ⚠  candidate failed: ${err instanceof Error ? err.message : String(err)}\n`);
		}
	}

	throw lastError ?? new Error("No official skill candidate succeeded");
}

run()
	.catch(async (err) => {
		console.error("\n❌ Official skill live test failed:", err instanceof Error ? err.message : String(err));
		process.exitCode = 1;
	})
	.finally(async () => {
		if (createdAgentId) {
			try {
				await adapter.deleteAgent(createdAgentId);
				console.log(`\n🧹 archived agent: ${createdAgentId}`);
			} catch (err) {
				console.log(`\n⚠  cleanup failed for ${createdAgentId}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
	});
