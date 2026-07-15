import { z } from "zod";

export const qoderConfigSchema = z.object({
	api_key: z.string(),
	gateway: z.string().optional(),
});

export type QoderConfig = z.infer<typeof qoderConfigSchema>;
