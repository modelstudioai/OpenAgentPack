import {
	BASE_PLAYBOOK_ID,
	DEFAULT_PLAYBOOK_PROVIDER,
	getDefaultPlaybook,
	getEnvironmentProfile,
	getPlaybook,
	getPlaybookAppId,
	getPlaybookDisplayName,
	getVaultProfile,
	listPlaybookCards,
	listPlaybooks,
	PLAYBOOK_AGENT_NAME_PREFIX,
	PLAYBOOK_APP_METADATA_KEY,
	resolveSeedPlaybookSkills,
} from "@openagentpack/playbooks";
import showcaseJson from "@/data/showcase.json";
import { resolveActivePlaybookProvider } from "@/lib/domain/config-api";
import type { ShowcaseCard } from "@/lib/showcase-types";
import type { RoleCard } from "./types";

export {
	BASE_PLAYBOOK_ID,
	DEFAULT_PLAYBOOK_PROVIDER,
	getEnvironmentProfile,
	getPlaybook,
	getPlaybookAppId,
	getPlaybookDisplayName,
	getVaultProfile,
	listPlaybooks,
	PLAYBOOK_AGENT_NAME_PREFIX,
	PLAYBOOK_APP_METADATA_KEY,
	resolveSeedPlaybookSkills,
};

type ShowcaseCategory = { key: string; label: string };
type ShowcaseData = { categories: ShowcaseCategory[]; cards: ShowcaseCard[] };

async function readShowcase(): Promise<ShowcaseData> {
	return showcaseJson as unknown as ShowcaseData;
}

let showcasePromise: Promise<ShowcaseData> | null = null;
function loadShowcase(): Promise<ShowcaseData> {
	showcasePromise ??= readShowcase();
	return showcasePromise;
}

/** Homepage playbook-fan view-model: presentation fields + CDN image + sample prompt.
 * The base playbook ("通用助手") is an internal fallback and must not appear in the UI. */
export async function getRoleCards(provider?: string): Promise<RoleCard[]> {
	const activeProvider = provider ?? (await resolveActivePlaybookProvider());
	return listPlaybookCards(undefined, activeProvider).flatMap((card) =>
		card.id === BASE_PLAYBOOK_ID
			? []
			: [
					{
						slug: card.id,
						name: card.title,
						prompt: card.prompt,
						imageUrl: card.imageUrl,
						playbookTemplateId: card.playbookTemplateId,
					},
				],
	);
}

/** Showcase gallery; unknown playbook references are rewritten to a visible homepage scenario. */
export async function getShowcase(provider?: string): Promise<ShowcaseData> {
	const activeProvider = provider ?? (await resolveActivePlaybookProvider());
	const showcase = await loadShowcase();
	const playbooks = listPlaybooks(activeProvider);
	const ids = new Set(playbooks.map((playbook) => playbook.id));
	// base 是内部兜底、不出现在首页；showcase「做同款」应落到当前渠道可见的场景
	const fallback = playbooks.find((p) => p.id !== BASE_PLAYBOOK_ID) ?? getDefaultPlaybook(activeProvider);
	const cards = showcase.cards.map((card) => {
		if (!card.playbookSlug || ids.has(card.playbookSlug)) return card;
		console.warn(`[showcase] 卡引用了未知玩法「${card.playbookSlug}」，回退到「${fallback?.id ?? "<none>"}」`);
		return { ...card, playbookSlug: fallback?.id };
	});
	return { ...showcase, cards };
}
