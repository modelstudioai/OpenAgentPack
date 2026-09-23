---
"@openagentpack/sdk": minor
"@openagentpack/cli": minor
"@openagentpack/playground": minor
---

Add Multi-Agent coordinator support for Qoder (Managed Agents and Forward Templates) and Bailian Managed Agents. `multiagent.agents` accepts project logical names plus explicit external Managed Agent references (`{ agent_id }`), validates the phase-1 topology (no self/nesting/cycles, max 20 members, Qoder members share the coordinator's delivery type), maps members to `id` or `template_id` wire references, clears rosters via `multiagent: null` or an empty array, compares multi-agent drift semantically, and exports remote coordinators back to logical names or stable external references. External members are not lifecycle-managed, and Qoder Forward rejects `{ agent_id }` because its roster requires Template ids.
