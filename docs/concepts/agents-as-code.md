# Agents as code

## The problem

Cloud AI agents are increasingly built by clicking through provider consoles: create an environment here, upload a skill there, paste an API key, wire up an MCP server. The resulting state lives only in the console — it cannot be reviewed in a PR, rolled back, reproduced on another account, or moved to a different vendor. As agents move from "call a model API in your own code" to "assemble an agent inside a vendor console", vendor lock-in re-forms one layer up — at the managed harness.

## The bet

OpenAgentPack treats an agent as **infrastructure as code**, the way Terraform treats cloud resources. A single `agents.yaml` is the desired state and the single source of truth. A Terraform-style workflow reconciles the real provider to match it:

```
validate → plan → apply → destroy
```

Because the declaration is a file, it gets everything a file gets: code review, version history, branching, rollback, and reproducibility across accounts and providers.

## Two layers worth distinguishing

- The **agent harness** is the provider-managed layer that wraps a model into an agent: knowledge base, skills, MCP wiring, prompt/instructions, vault, deployment, multi-agent orchestration. These are the customer's portable assets.
- The **agent infra** is the interchangeable execution substrate beneath the harness — the specific provider (Bailian, Qoder, Claude, Volcengine Ark) that runs the agent.

OpenAgentPack's portability claim is that the same harness declaration can target different agent infra. Portability means the *core declaration* is portable and the per-provider **capability contract** is explicit — unsupported facets degrade gracefully (for example, an emulated `Deployment` on Bailian/Qoder/Volcengine Ark) — not that every feature is identical on every provider.

## What this enables

- **Preview before mutation** — `plan` shows every create / update / delete before any API call mutates remote.
- **Incremental runs** — content-hash diffing skips unchanged resources; only what actually changed is touched.
- **Dependency-aware ordering** — Environment → Skill → Agent are created in topological order; a failed dependency skips its dependents instead of leaving half-built state.
- **Drift recovery** — because the YAML is the source of truth, `apply` reconciles remote drift back to the declaration.

Continue with [Resources](./resources.md) and [State and drift](./state-and-drift.md) for the mental model behind these behaviors.
