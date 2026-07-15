# Bailian provider implementation references

OpenAgentPack implements Aliyun Bailian Managed Agents through the public AgentStudio REST API. This file records only repository-specific integration notes; the API contract remains owned and maintained by Aliyun.

Official references:

- [Managed Agents API overview and authentication](https://help.aliyun.com/zh/model-studio/managed-agents-api-overview)
- [List sessions](https://help.aliyun.com/zh/model-studio/session-list)

Implementation:

- `packages/sdk/src/internal/providers/bailian/`
- `packages/sdk/tests/e2e/bailian-adapter.test.ts`
- `packages/sdk/docs/providers/bailian-vault-integration.md`

Do not copy the full upstream API documentation into this repository. Link to the canonical provider pages so authentication, fields, limits, and examples remain current.
