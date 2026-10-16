# Bailian workspace Webhooks

Webhook endpoints belong to the workspace. The SDK exposes their operation-level APIs without requiring an `agents.yaml` file, a project name, or a state backend. They do not participate in project `plan`, `apply`, `sync`, or `destroy`.

The provider owns the wire contract:

- [Webhook introduction](https://docs.agent.bailian.aliyun.com/zh/managed-agents/webhooks/introduction)
- [Create endpoint](https://docs.agent.bailian.aliyun.com/zh/api/managed-agents/webhook/create)
- [Callback envelope and signature](https://docs.agent.bailian.aliyun.com/zh/api/managed-agents/webhook/callback)
- [Test delivery](https://docs.agent.bailian.aliyun.com/zh/api/managed-agents/webhook/test)
- [Delivery-event history](https://docs.agent.bailian.aliyun.com/zh/api/managed-agents/webhook/list-events)

## Initialize a workspace context

```ts
import {
  createManagedApiContext,
  listRemoteWebhookEndpoints,
  resolveBailianApiBaseUrl,
} from "@openagentpack/sdk";

const context = createManagedApiContext({
  providers: {
    bailian: {
      api_key: process.env.DASHSCOPE_API_KEY,
      base_url: resolveBailianApiBaseUrl({
        workspaceId: process.env.BAILIAN_WORKSPACE_ID,
      }),
    },
  },
});

const endpoints = await listRemoteWebhookEndpoints(context, { provider: "bailian" });
```

The host resolves credentials and passes the resulting provider config in memory. `createManagedApiContext` validates it and creates adapters through the existing provider registry; it does not bootstrap environment credentials or perform file/network I/O. An existing `ProjectRuntimeContext` is also accepted by the Webhook functions.

`resolveBailianApiBaseUrl({ baseUrl, workspaceId })` accepts an explicit HTTP(S) origin or an AgentStudio API base URL, normalizes its trailing slash, and appends the API path exactly once. Without `baseUrl`, it constructs the Beijing workspace endpoint. Other regions and custom gateways use an explicit endpoint. This helper does not change the existing Bailian provider's verbatim `base_url` behavior.

## Available operations

| SDK function | Result |
| --- | --- |
| `createRemoteWebhookEndpoint(context, input, options?)` | Endpoint with the one-time signing secret |
| `listRemoteWebhookEndpoints(context, options?)` | Complete workspace list with `data` and `request_id` |
| `getRemoteWebhookEndpoint(context, id, options?)` | Endpoint |
| `updateRemoteWebhookEndpoint(context, id, input, options?)` | Updated endpoint |
| `deleteRemoteWebhookEndpoint(context, id, options?)` | JSON deletion response containing `request_id` |
| `enableRemoteWebhookEndpoint(context, id, options?)` | Enabled endpoint |
| `disableRemoteWebhookEndpoint(context, id, options?)` | Disabled endpoint |
| `testRemoteWebhookEndpoint(context, id, options?)` | Test event and `request_id` |
| `resetRemoteWebhookSecret(context, id, options?)` | ID, one-time signing secret, update time, and `request_id` |
| `listRemoteWebhookEvents(context, id, options?)` | Delivery events, nullable `next_page`, and `request_id` |

All operations accept `{ provider?, signal? }`. Event listing additionally accepts `{ limit?, page? }`; cursors remain opaque and the SDK does not synthesize `has_more`. Endpoint listing has no pagination.

Updates preserve omitted fields. An explicitly supplied `events` array replaces the complete subscription array; `description: null` or `description: ""` clears the description. The SDK preserves provider responses and error bodies rather than translating provider error codes or inferring delivery success from undocumented fields.

Creation and secret reset return a secret that cannot subsequently be retrieved. The host must deliver it to the caller or to an explicitly selected secret destination. SDK requests do not log responses, persist secrets, or automatically retry writes. Host-injected transports must preserve that no-replay property, especially when a creation or reset request has an uncertain outcome. Cancellation is passed to the injected fetch implementation as an `AbortSignal`.

These APIs configure the provider and query deliveries. A callback receiver and signature verification run in the receiving application; refer to the provider callback documentation for that protocol.

Implementation and protocol tests:

- `packages/sdk/src/internal/core/managed-api-context.ts`
- `packages/sdk/src/internal/core/webhook-runtime.ts`
- `packages/sdk/src/internal/types/webhook.ts`
- `packages/sdk/src/internal/providers/bailian/adapter.ts`
- `packages/sdk/tests/unit/bailian-webhook.test.ts`
