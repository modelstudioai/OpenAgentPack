import { z } from "zod";

export const arkConfigSchema = z.object({
	api_key: z.string(),
});

export type ArkConfig = z.infer<typeof arkConfigSchema>;
