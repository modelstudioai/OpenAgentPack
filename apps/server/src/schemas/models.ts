import { z } from "@hono/zod-openapi";

// Provider-driven model option. Mirrors the SDK's ProviderModelInfo; only the fields the UI
// selector needs are surfaced. Empty `models` means the provider has no dynamic listing (the
// frontend then falls back to its bundled catalog).
export const ModelOptionSchema = z.object({
	id: z.string(),
	display_name: z.string(),
	is_enabled: z.boolean().optional(),
	is_new: z.boolean().optional(),
});

export const ModelsResponseSchema = z.object({
	models: z.array(ModelOptionSchema),
});
