import { afterEach, describe, expect, test } from "bun:test";
import {
	ApiError,
	createManagedApiContext,
	createRemoteWebhookEndpoint,
	deleteRemoteWebhookEndpoint,
	disableRemoteWebhookEndpoint,
	enableRemoteWebhookEndpoint,
	getManagedAgentProviderCapabilities,
	getRemoteWebhookEndpoint,
	listRemoteWebhookEndpoints,
	listRemoteWebhookEvents,
	type ManagedApiContext,
	resetRemoteWebhookSecret,
	resolveBailianApiBaseUrl,
	setDefaultFetch,
	testRemoteWebhookEndpoint,
	updateRemoteWebhookEndpoint,
	type WebhookEndpoint,
	type WebhookRequestOptions,
} from "../../src/index.ts";
import { BailianClient } from "../../src/internal/providers/bailian/client.ts";

const BASE_URL = "https://workspace.example/api/v1/agentstudio";
const WEBHOOK_ID = "wep_test";

const endpoint: WebhookEndpoint = {
	id: WEBHOOK_ID,
	description: null,
	url: "https://callback.example/webhook",
	events: ["session.updated"],
	status: "ACTIVE",
	disabled_reason: null,
	consecutive_fail: 0,
	last_success_at: null,
	last_failure_at: null,
	created_at: "2026-08-06T10:00:00Z",
	updated_at: "2026-08-06T10:00:00Z",
};

const testEvent = {
	type: "event",
	id: "whe_test",
	created_at: "2026-08-06T10:00:00.001Z",
	data: { id: WEBHOOK_ID, type: "webhook.test", workspace_id: "workspace" },
	request_id: "request-test",
};

function context(): ManagedApiContext {
	return createManagedApiContext({
		providers: { bailian: { api_key: "sk-test", base_url: BASE_URL } },
	});
}

function installResponse(response: unknown, status = 200) {
	const calls: Array<{ url: string; init?: RequestInit }> = [];
	setDefaultFetch(async (input, init) => {
		calls.push({ url: String(input), init });
		return new Response(JSON.stringify(response), { status, headers: { "Content-Type": "application/json" } });
	});
	return calls;
}

afterEach(() => {
	setDefaultFetch(undefined);
});

describe("workspace API context and endpoint resolution", () => {
	test("creates only provider adapters without making a request", () => {
		const calls = installResponse({});
		const runtime = context();
		expect(Object.keys(runtime)).toEqual(["providers"]);
		expect([...runtime.providers.keys()]).toEqual(["bailian"]);
		expect(calls).toHaveLength(0);
	});

	test("validates supplied config without consulting ambient credentials", () => {
		expect(() => createManagedApiContext({ providers: { bailian: { base_url: BASE_URL } } })).toThrow("api_key");
	});

	test("rejects missing, ambiguous, and unsupported providers before HTTP", async () => {
		const calls = installResponse({});
		await expect(listRemoteWebhookEndpoints(createManagedApiContext({ providers: {} }))).rejects.toThrow(
			"No providers",
		);
		await expect(listRemoteWebhookEndpoints(context(), { provider: "missing" })).rejects.toThrow("not configured");
		const multiple = createManagedApiContext({
			providers: { bailian: { api_key: "sk-test", base_url: BASE_URL }, claude: { api_key: "sk-test" } },
		});
		await expect(listRemoteWebhookEndpoints(multiple)).rejects.toThrow("Multiple providers");
		await expect(listRemoteWebhookEndpoints(multiple, { provider: "claude" })).rejects.toThrow(
			"does not support webhook listing",
		);
		expect(calls).toHaveLength(0);
	});

	test("normalizes origins and API suffixes, with explicit endpoints taking precedence", () => {
		for (const baseUrl of ["https://workspace.example", "https://workspace.example/", `${BASE_URL}/`, BASE_URL]) {
			expect(resolveBailianApiBaseUrl({ baseUrl, workspaceId: "ignored" })).toBe(BASE_URL);
		}
		expect(resolveBailianApiBaseUrl({ workspaceId: "workspace-123" })).toBe(
			"https://workspace-123.cn-beijing.maas.aliyuncs.com/api/v1/agentstudio",
		);
		expect(resolveBailianApiBaseUrl({ baseUrl: "http://localhost:1234/" })).toBe(
			"http://localhost:1234/api/v1/agentstudio",
		);
	});

	test("rejects invalid endpoint input without echoing secret-bearing URLs", () => {
		for (const baseUrl of [
			"",
			"invalid",
			"ftp://workspace.example",
			"https://user:password@workspace.example",
			`${BASE_URL}?token=secret`,
			`${BASE_URL}#fragment`,
			"https://workspace.example/unrelated",
		]) {
			expect(() => resolveBailianApiBaseUrl({ baseUrl })).toThrow("Bailian API base URL");
		}
		expect(() => resolveBailianApiBaseUrl({})).toThrow("workspace ID");
		expect(() => resolveBailianApiBaseUrl({ workspaceId: "workspace/invalid" })).toThrow("workspace ID");
	});

	test("keeps existing BailianClient custom base URL behavior unchanged", async () => {
		const calls = installResponse({});
		await new BailianClient({ apiKey: "sk-test", baseUrl: "https://gateway.example/custom" }).get("/resource");
		expect(calls[0]?.url).toBe("https://gateway.example/custom/resource");
	});
});

describe("Bailian webhook wire contract", () => {
	const cases: Array<{
		name: string;
		method: string;
		path: string;
		body?: unknown;
		status?: number;
		response: unknown;
		run: (runtime: ManagedApiContext, options: WebhookRequestOptions) => Promise<unknown>;
	}> = [
		{
			name: "create",
			method: "POST",
			path: "/webhook_endpoints",
			body: { url: endpoint.url, events: endpoint.events },
			status: 201,
			response: { ...endpoint, signing_secret: "whsec_test_create", request_id: "request-create" },
			run: (runtime, options) =>
				createRemoteWebhookEndpoint(runtime, { url: endpoint.url, events: endpoint.events }, options),
		},
		{
			name: "list without pagination",
			method: "GET",
			path: "/webhook_endpoints",
			response: { data: [endpoint], request_id: "request-list" },
			run: listRemoteWebhookEndpoints,
		},
		{
			name: "get",
			method: "GET",
			path: `/webhook_endpoints/${WEBHOOK_ID}`,
			response: { ...endpoint, request_id: "request-get" },
			run: (runtime, options) => getRemoteWebhookEndpoint(runtime, WEBHOOK_ID, options),
		},
		{
			name: "partial PUT preserves null",
			method: "PUT",
			path: `/webhook_endpoints/${WEBHOOK_ID}`,
			body: { description: null },
			response: { ...endpoint, request_id: "request-update" },
			run: (runtime, options) =>
				updateRemoteWebhookEndpoint(runtime, WEBHOOK_ID, { description: null, events: undefined }, options),
		},
		{
			name: "delete preserves response request ID",
			method: "DELETE",
			path: `/webhook_endpoints/${WEBHOOK_ID}`,
			response: { request_id: "request-delete" },
			run: (runtime, options) => deleteRemoteWebhookEndpoint(runtime, WEBHOOK_ID, options),
		},
		{
			name: "enable",
			method: "POST",
			path: `/webhook_endpoints/${WEBHOOK_ID}/enable`,
			response: { ...endpoint, request_id: "request-enable" },
			run: (runtime, options) => enableRemoteWebhookEndpoint(runtime, WEBHOOK_ID, options),
		},
		{
			name: "disable",
			method: "POST",
			path: `/webhook_endpoints/${WEBHOOK_ID}/disable`,
			response: {
				...endpoint,
				status: "DISABLED",
				disabled_reason: "future-server-reason",
				request_id: "request-disable",
			},
			run: (runtime, options) => disableRemoteWebhookEndpoint(runtime, WEBHOOK_ID, options),
		},
		{
			name: "test returns an event",
			method: "POST",
			path: `/webhook_endpoints/${WEBHOOK_ID}/test`,
			response: testEvent,
			run: (runtime, options) => testRemoteWebhookEndpoint(runtime, WEBHOOK_ID, options),
		},
		{
			name: "reset secret preserves the one-time result",
			method: "POST",
			path: `/webhook_endpoints/${WEBHOOK_ID}/reset_secret`,
			response: {
				id: WEBHOOK_ID,
				signing_secret: "whsec_test_reset",
				updated_at: endpoint.updated_at,
				request_id: "request-reset",
			},
			run: (runtime, options) => resetRemoteWebhookSecret(runtime, WEBHOOK_ID, options),
		},
		{
			name: "events preserve delivery details and nullable cursor",
			method: "GET",
			path: `/webhook_endpoints/${WEBHOOK_ID}/events?limit=100&page=opaque%2B%2F%3D`,
			response: {
				data: [
					{
						...testEvent,
						data: {
							id: "sess_test",
							type: "session.updated",
							workspace_id: "workspace",
							session_thread_id: "thread_test",
							vault_id: "vault_test",
							future_field: "preserved",
						},
						delivery: {
							webhook_id: WEBHOOK_ID,
							status: "FUTURE_STATUS",
							attempt_count: 2,
							delivery_at: null,
							finish_at: null,
							failure_reason: null,
						},
					},
				],
				next_page: null,
				request_id: "request-events",
			},
			run: (runtime, options) =>
				listRemoteWebhookEvents(runtime, WEBHOOK_ID, { ...options, limit: 100, page: "opaque+/=" }),
		},
	];

	for (const scenario of cases) {
		test(scenario.name, async () => {
			const calls = installResponse(scenario.response, scenario.status);
			const controller = new AbortController();
			const result = await scenario.run(context(), { provider: "bailian", signal: controller.signal });
			expect(result).toEqual(scenario.response);
			expect(calls).toHaveLength(1);
			expect(calls[0]?.url).toBe(`${BASE_URL}${scenario.path}`);
			expect(calls[0]?.init?.method).toBe(scenario.method);
			expect(calls[0]?.init?.headers).toEqual({ "Content-Type": "application/json", Authorization: "Bearer sk-test" });
			expect(calls[0]?.init?.signal).toBe(controller.signal);
			expect(calls[0]?.init?.body).toBe(scenario.body === undefined ? undefined : JSON.stringify(scenario.body));
		});
	}

	test("PUT preserves empty description and replaces the exact events array", async () => {
		const calls = installResponse(endpoint);
		await updateRemoteWebhookEndpoint(context(), WEBHOOK_ID, { description: "", events: ["session.status_idled"] });
		expect(JSON.parse(calls[0]?.init?.body as string)).toEqual({ description: "", events: ["session.status_idled"] });
	});

	test("event history omits defaults and preserves opaque non-null cursors", async () => {
		const response = { data: [], next_page: "opaque-next+/=", request_id: "request-page" };
		const calls = installResponse(response);
		expect(await listRemoteWebhookEvents(context(), WEBHOOK_ID)).toEqual(response);
		expect(calls[0]?.url).toBe(`${BASE_URL}/webhook_endpoints/${WEBHOOK_ID}/events`);
	});

	test("escapes endpoint IDs as one path segment", async () => {
		const calls = installResponse(endpoint);
		await getRemoteWebhookEndpoint(context(), "wep_id/with?query#fragment");
		expect(calls[0]?.url).toBe(`${BASE_URL}/webhook_endpoints/wep_id%2Fwith%3Fquery%23fragment`);
	});

	test("retains additional test response fields without interpreting them", async () => {
		const response = { ...testEvent, success: false, error: { message: "provider-owned detail" } };
		installResponse(response);
		expect(await testRemoteWebhookEndpoint(context(), WEBHOOK_ID)).toEqual(response);
	});

	for (const status of [400, 401, 404, 409, 502]) {
		test(`preserves HTTP ${status} and the exact server error without retrying`, async () => {
			const response = {
				type: "error",
				request_id: "request-failure",
				error: { code: "11800016", message: "provider-owned detail" },
			};
			const calls = installResponse(response, status);
			try {
				await testRemoteWebhookEndpoint(context(), WEBHOOK_ID);
				throw new Error("Expected provider error");
			} catch (error) {
				expect(error).toBeInstanceOf(ApiError);
				expect((error as ApiError).statusCode).toBe(status);
				expect((error as ApiError).responseBody).toBe(JSON.stringify(response));
			}
			expect(calls).toHaveLength(1);
		});
	}

	test("does not replay create or reset after a transport failure", async () => {
		for (const operation of [
			() => createRemoteWebhookEndpoint(context(), { url: endpoint.url, events: endpoint.events }),
			() => resetRemoteWebhookSecret(context(), WEBHOOK_ID),
		]) {
			let attempts = 0;
			const failure = new TypeError("transport unavailable");
			setDefaultFetch(async () => {
				attempts++;
				throw failure;
			});
			await expect(operation()).rejects.toBe(failure);
			expect(attempts).toBe(1);
		}
	});

	test("propagates cancellation to an in-flight HTTP request", async () => {
		const controller = new AbortController();
		setDefaultFetch(
			async (_input, init) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
				}),
		);
		const operation = getRemoteWebhookEndpoint(context(), WEBHOOK_ID, { signal: controller.signal });
		const reason = new Error("cancel webhook request");
		controller.abort(reason);
		await expect(operation).rejects.toBe(reason);
	});

	test("legacy DELETE still accepts a 204 response", async () => {
		setDefaultFetch(async () => new Response(null, { status: 204 }));
		const result = await new BailianClient({ apiKey: "sk-test", baseUrl: BASE_URL }).delete("/agents/agent-test");
		expect(result).toBeUndefined();
	});

	test("declares all ten Bailian webhook operations with API-key auth", () => {
		const operations = getManagedAgentProviderCapabilities("bailian").operations;
		for (const action of [
			"create",
			"list",
			"get",
			"update",
			"delete",
			"enable",
			"disable",
			"test",
			"reset_secret",
			"events",
		]) {
			expect(operations[`webhook.${action}`]).toEqual({ supported: true, auth: "api_key" });
		}
		expect(getManagedAgentProviderCapabilities("claude").operations["webhook.create"]).toBeUndefined();
	});
});
