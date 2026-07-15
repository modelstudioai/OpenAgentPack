import { z } from "zod";

export const bailianConfigSchema = z.object({
	api_key: z.string(),
	workspace_id: z.string(),
	base_url: z.string().optional(),
});

export type BailianConfig = z.infer<typeof bailianConfigSchema>;
