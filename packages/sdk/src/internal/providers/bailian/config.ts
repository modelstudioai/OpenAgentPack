import { z } from "zod";

// workspace_id and base_url are both optional but at least one is required: the
// client derives the AgentStudio base URL from workspace_id, or takes base_url
// verbatim. Hosts that only know the full endpoint (e.g. bl's --agentstudio-base-url)
// can supply base_url and skip workspace_id entirely.
export const bailianConfigSchema = z
	.object({
		api_key: z.string(),
		workspace_id: z.string().optional(),
		base_url: z.string().optional(),
	})
	.refine((config) => Boolean(config.workspace_id || config.base_url), {
		message: "either workspace_id or base_url is required",
	});

export type BailianConfig = z.infer<typeof bailianConfigSchema>;
