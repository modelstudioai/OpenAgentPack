# OpenAgentPack

OpenAgentPack manages cloud AI-agent infrastructure with declarative YAML, the way Terraform manages cloud resources.

## Language

**Open Agent Pack**:
An AI agent whose runtime harness — environment, vault, memory_store, skills, files, MCP servers, prompt/instructions, agent loop, multi-agent orchestration, deployment — is hosted and operated by a cloud provider (Bailian, Qoder, Claude, Volcengine Ark), not by the user's own code. The category OpenAgentPack operates on. The CLI is invoked as `agents`; the config file is `agents.yaml`.
_Avoid_: "hosted agent", "cloud agent" when precision about the *managed harness* matters. Avoid the abbreviation "OAP".

**Agent Harness**:
The provider-managed runtime layer that wraps a model to make it an agent: memory_store, skills, MCP servers, prompt/instructions, and the agent loop. The *declarations* of these are the customer's portable assets; the provider operates the runtime that instantiates them. Distinct from the underlying model inference API.
_Avoid_: conflating with the model or the SDK.

**Agent Infra**:
The interchangeable execution substrate beneath the Harness — the specific provider (Bailian / Qoder / Claude / Volcengine Ark) that runs the agent. OpenAgentPack's portability claim is that the same Harness declaration can target different Agent Infra.

**Agent-layer lock-in**:
The forward-looking risk OpenAgentPack is a bet against: as agents move from "call a model API in your own code" to "assemble an agent inside a vendor console", vendor lock-in re-forms one layer up — at the managed harness. The declaration in the console can't be reviewed, versioned, reproduced, or moved.

**Capability contract**:
The explicit, per-provider capability matrix OpenAgentPack publishes (native / emulated / unsupported per resource kind). Portability means the *core declaration* is portable plus this contract is explicit and unsupported facets degrade gracefully (e.g. a provider emulating a non-native MCP transport or memory backend) — not that every feature is identical on every provider. Capability tiers are point-in-time: a resource emulated on a provider today may turn native as that provider catches up; only the matrix cell changes, not the resource's declared status.

## Resources and workflow

OpenAgentPack treats agents as **infrastructure as code**. A single `agents.yaml` declares the desired state and is the single source of truth. A Terraform-style workflow reconciles the real provider to match it: `validate → plan → apply → destroy`.

Declared resources: `environment`, `vault`, `memory_store`, `skill`, `file`, `agent`, `deployment`. `mcp_server` and `multiagent` are expressed through an agent; `session` is a runtime conversation started from a managed agent, not a declared resource. `deployment` declares scheduled/triggered runs of an agent; while every provider is expected to converge on native support, some currently expose it only via emulation — `plan` surfaces the tier and any behavioral differences.

At any moment there are three descriptions: **config** (the YAML, desired state), **state** (a local state file mapping declared resources to remote IDs with content hashes), and **remote** (what actually exists on the provider). `plan` computes the diff; `apply` makes remote match config and updates state; content-hash diffing makes runs incremental; failed dependencies skip their dependents rather than leaving half-built state.

## Terms to keep distinct

- **agent** (declared `agents.yaml` resource) vs **session** (runtime conversation from an agent) vs **deployment** (a declared resource that produces runs). Must not be conflated.
- **config** / **state** / **remote** — must stay aligned with the three-sources-of-truth model.
- **native** / **emulated** / **unsupported** — the three capability tiers; an `unsupported` facet is a validation error with remediation, not a runtime surprise.
