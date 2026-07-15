import { z } from "zod";

export const claudeConfigSchema = z.object({
	api_key: z.string(),
	beta: z.string().optional(),
});

export type ClaudeConfig = z.infer<typeof claudeConfigSchema>;
