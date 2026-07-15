import bundledModels from "@/data/models.json";
import { modelIcons } from "@/data/static-assets";
import { getApiModels } from "../api/client";

export interface UiModel {
	id: string;
	name: string;
	description?: string;
	icon: string;
}

function withIcon(m: { id: string; name: string; description?: string }): UiModel {
	return { id: m.id, name: m.name, description: m.description, icon: modelIcons[m.id] ?? "" };
}

// The bundled catalog is the bailian model set; it's the fallback whenever the active provider has
// no dynamic listing (bailian).
const fallbackCatalog: UiModel[] = (bundledModels as { id: string; name: string; description?: string }[]).map(
	withIcon,
);

/**
 * Resolve the model list the selector should offer. Prefers the active provider's dynamic listing
 * (a provider like qoder), and falls back to the bundled bailian catalog when the provider
 * returns nothing (bailian, or on error). This is what keeps a qoder deployment from sending
 * a bailian model id (which the provider rejects at agent creation).
 */
export async function getModels(): Promise<UiModel[]> {
	try {
		const { data } = await getApiModels();
		const enabled = (data?.models ?? []).filter((m) => m.is_enabled !== false);
		if (enabled.length) {
			return enabled.map((m) => withIcon({ id: m.id, name: m.display_name }));
		}
	} catch {
		// fall through to the bundled catalog
	}
	return fallbackCatalog;
}
