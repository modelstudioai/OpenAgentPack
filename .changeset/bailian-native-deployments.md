---
"@openagentpack/sdk": minor
---

Bailian: implement native Deployment support against the Agent Studio `/deployments` API (create, get, list, update, archive, run, pause/unpause), replacing the previous emulated session expansion. Deployment schedules now run server-side; `user.define_outcome` events and `github_repository` resources are dropped from the deployment payload and surface a warning on plan.
