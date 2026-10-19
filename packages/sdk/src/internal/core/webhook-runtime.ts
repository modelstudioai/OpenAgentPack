import type {
	CreateWebhookEndpointInput,
	UpdateWebhookEndpointInput,
	WebhookDeleteResult,
	WebhookEndpoint,
	WebhookEndpointList,
	WebhookEndpointWithSecret,
	WebhookEventListOptions,
	WebhookEventPage,
	WebhookRequestOptions,
	WebhookSecretResetResult,
	WebhookTestResult,
} from "../types/webhook.ts";
import { type ManagedApiContext, requireManagedApiMethod, resolveManagedApiAdapter } from "./managed-api-context.ts";

export async function createRemoteWebhookEndpoint(
	ctx: ManagedApiContext,
	input: CreateWebhookEndpointInput,
	options: WebhookRequestOptions = {},
): Promise<WebhookEndpointWithSecret> {
	const adapter = resolveManagedApiAdapter(ctx, options.provider);
	const method = requireManagedApiMethod(adapter.createWebhookEndpoint, adapter.name, "webhook creation");
	return method.call(adapter, input, options);
}

export async function listRemoteWebhookEndpoints(
	ctx: ManagedApiContext,
	options: WebhookRequestOptions = {},
): Promise<WebhookEndpointList> {
	const adapter = resolveManagedApiAdapter(ctx, options.provider);
	const method = requireManagedApiMethod(adapter.listWebhookEndpoints, adapter.name, "webhook listing");
	return method.call(adapter, options);
}

export async function getRemoteWebhookEndpoint(
	ctx: ManagedApiContext,
	id: string,
	options: WebhookRequestOptions = {},
): Promise<WebhookEndpoint> {
	const adapter = resolveManagedApiAdapter(ctx, options.provider);
	const method = requireManagedApiMethod(adapter.getWebhookEndpoint, adapter.name, "webhook lookup");
	return method.call(adapter, id, options);
}

export async function updateRemoteWebhookEndpoint(
	ctx: ManagedApiContext,
	id: string,
	input: UpdateWebhookEndpointInput,
	options: WebhookRequestOptions = {},
): Promise<WebhookEndpoint> {
	const adapter = resolveManagedApiAdapter(ctx, options.provider);
	const method = requireManagedApiMethod(adapter.updateWebhookEndpoint, adapter.name, "webhook update");
	return method.call(adapter, id, input, options);
}

export async function deleteRemoteWebhookEndpoint(
	ctx: ManagedApiContext,
	id: string,
	options: WebhookRequestOptions = {},
): Promise<WebhookDeleteResult> {
	const adapter = resolveManagedApiAdapter(ctx, options.provider);
	const method = requireManagedApiMethod(adapter.deleteWebhookEndpoint, adapter.name, "webhook deletion");
	return method.call(adapter, id, options);
}

export async function enableRemoteWebhookEndpoint(
	ctx: ManagedApiContext,
	id: string,
	options: WebhookRequestOptions = {},
): Promise<WebhookEndpoint> {
	const adapter = resolveManagedApiAdapter(ctx, options.provider);
	const method = requireManagedApiMethod(adapter.enableWebhookEndpoint, adapter.name, "webhook enabling");
	return method.call(adapter, id, options);
}

export async function disableRemoteWebhookEndpoint(
	ctx: ManagedApiContext,
	id: string,
	options: WebhookRequestOptions = {},
): Promise<WebhookEndpoint> {
	const adapter = resolveManagedApiAdapter(ctx, options.provider);
	const method = requireManagedApiMethod(adapter.disableWebhookEndpoint, adapter.name, "webhook disabling");
	return method.call(adapter, id, options);
}

export async function testRemoteWebhookEndpoint(
	ctx: ManagedApiContext,
	id: string,
	options: WebhookRequestOptions = {},
): Promise<WebhookTestResult> {
	const adapter = resolveManagedApiAdapter(ctx, options.provider);
	const method = requireManagedApiMethod(adapter.testWebhookEndpoint, adapter.name, "webhook testing");
	return method.call(adapter, id, options);
}

export async function resetRemoteWebhookSecret(
	ctx: ManagedApiContext,
	id: string,
	options: WebhookRequestOptions = {},
): Promise<WebhookSecretResetResult> {
	const adapter = resolveManagedApiAdapter(ctx, options.provider);
	const method = requireManagedApiMethod(adapter.resetWebhookSecret, adapter.name, "webhook secret reset");
	return method.call(adapter, id, options);
}

export async function listRemoteWebhookEvents(
	ctx: ManagedApiContext,
	id: string,
	options: WebhookEventListOptions = {},
): Promise<WebhookEventPage> {
	const adapter = resolveManagedApiAdapter(ctx, options.provider);
	const method = requireManagedApiMethod(adapter.listWebhookEvents, adapter.name, "webhook event listing");
	return method.call(adapter, id, options);
}
