# Multi-Agent Live Probe Results

Sanitized execution records for `packages/sdk/tests/e2e/multiagent-live.ts` (step 10 of
`docs/architecture/multi-agent-implementation-plan.md`). One run per mode: `qoder-managed`,
`qoder-forward`, `bailian`. All output below is verbatim probe stdout — it contains only the
probe's own `oap-ma-live-*` test resource ids; no tokens, no user metadata, no other resources
are listed. Every resource created during each run was removed in the probe's `finally` cleanup
(verified in the trailing cleanup block of each run).

## qoder-managed — 2026-09-22

```text
$ bun packages/sdk/tests/e2e/multiagent-live.ts qoder-managed

=== Multi-Agent Live Probe: qoder-managed (prefix oap-ma-live-mucu9ycr) ===

1. validate()...
   ✅ validate passed

2. createEnvironment()...
   ✅ created environment: env_00q8c2jags83l12bakzp

3. createAgent() worker...
   ✅ created worker agent: agent_00q8c2jhbz18gar8ua33 (version=1)

4. createAgent() coordinator with multiagent roster...
   ✅ created coordinator agent: agent_00q8c2jo9qwhsoa32foy (version=1)

5. readComparableResource() — roster wired with member id...
   ✅ remote roster = {"type":"coordinator","member_ids":["agent_00q8c2jhbz18gar8ua33"]}

6. createSession() + sendSessionMessage() on the coordinator...
   ✅ session sess_00q8c2k1b7n5sr84el7m: status=idle, events={"session.status_running":1,"session.thread_status_running":3,"user.message":1,"span.model_request_start":3,"agent.tool_use":1,"span.model_request_end":3,"session.thread_created":1,"agent.thread_message_sent":1,"agent.tool_result":1,"session.thread_status_idle":3,"agent.thread_message_received":1,"agent.message":1,"session.usage":1,"session.status_idle":1}, threaded=0

7. updateAgent() without multiagent — roster must clear (multiagent: null)...
   ✅ remote roster cleared

=== Multi-Agent live probe (qoder-managed) passed! ===

🧹 Cleanup (qoder-managed) — destroy order is the reverse of creation
   🧹 removed session: sess_00q8c2k1b7n5sr84el7m
   🧹 archived/deleted coordinator: agent_00q8c2jo9qwhsoa32foy
   🧹 archived/deleted worker: agent_00q8c2jhbz18gar8ua33
   🧹 deleted environment: env_00q8c2jags83l12bakzp
```

Notes: `threaded=0` means no event carried `session_thread_id`; Qoder thread-id surfacing is out
of Phase 1 scope (Session Thread interfaces are a plan non-goal), and the probe's pass criteria do
not depend on it. An earlier qoder-managed run left environment `env_00q8brhhrfw8yqv4kdxt` behind
because cleanup passed `cascade=false`; the probe now passes `cascade=true` (Qoder rejects
environment deletion with "referenced by 0 session(s): . Use --cascade" even when zero sessions
remain), and the leftover environment was deleted and verified gone via `findResource` before this
recorded re-run.

## qoder-forward — 2026-09-22

```text
$ bun packages/sdk/tests/e2e/multiagent-live.ts qoder-forward

=== Multi-Agent Live Probe: qoder-forward (prefix oap-ma-live-mucuahbf) ===

1. validate()...
   ✅ validate passed

2. createIdentity()...
   ✅ created identity: idn_1848bb09c3963960fb2f5c94

3. createEnvironment(forward)...
   ✅ created forward environment: env_00q8c3uu7paf52hmk7wh

4. createTemplate() worker...
   ✅ created worker template: tmpl_c615e13dd02aa8d5d7675223

5. createTemplate() coordinator with multiagent roster...
   ✅ created coordinator template: tmpl_e663465e1c8c2e1410e8d43a

6. readComparableResource() — roster wired with template_id...
   ✅ remote roster = {"type":"coordinator","member_ids":["tmpl_c615e13dd02aa8d5d7675223"]}

7. createSession(forward) + sendSessionMessage() on the coordinator...
   ✅ session sess_00q8c3vzwj8xsqcx5l1z: status=idle, events={"session.status_running":1,"session.thread_status_running":3,"user.message":1,"span.model_request_start":3,"agent.tool_use":1,"span.model_request_end":3,"session.thread_created":1,"agent.thread_message_sent":1,"agent.tool_result":1,"agent.thread_message_received":1,"agent.message":1,"session.usage":1,"session.status_idle":1}, threaded=0

8. updateTemplate() without multiagent — roster must clear (multiagent: null)...
   ✅ remote roster cleared

=== Multi-Agent live probe (qoder-forward) passed! ===

🧹 Cleanup (qoder-forward) — destroy order is the reverse of creation
   🧹 removed session: sess_00q8c3vzwj8xsqcx5l1z
   🧹 archived coordinator: tmpl_e663465e1c8c2e1410e8d43a
   🧹 archived worker: tmpl_c615e13dd02aa8d5d7675223
   🧹 deleted identity: idn_1848bb09c3963960fb2f5c94
   🧹 deleted environment: env_00q8c3uu7paf52hmk7wh
```

## bailian — 2026-09-22

```text
$ bun packages/sdk/tests/e2e/multiagent-live.ts bailian

=== Multi-Agent Live Probe: bailian (prefix oap-ma-live-mucu4tos) ===

1. validate()...
   ✅ validate passed

2. createEnvironment()...
   ✅ created environment: env_ZTEzMDg0ZmU4MGY3NDBkZj

3. createAgent() worker...
   ✅ created worker agent: agent_01M34W2QPZR96PV5FRZEVW75VS (version=1)

4. createAgent() coordinator with multiagent roster...
   ✅ created coordinator agent: agent_01M34W2QVVMFCB5VR2JB4CSQT5 (version=1)

5. readComparableResource() — roster wired with member id...
   ✅ remote roster = {"type":"coordinator","member_ids":["agent_01M34W2QPZR96PV5FRZEVW75VS"]}

6. createSession() + sendSessionMessage() on the coordinator...
   ✅ session sesn_01M34W2R2C6JFB30QE0ANY0ET6: status=idle, events={"session_status":2,"message":3,"model_request_start":5,"reasoning":5,"model_request_end":5,"tool_call":3,"thread_created":1,"thread_message_sent":2,"thread_message_received":2,"thread_status":2,"tool_call_output":3}, threaded=3

7. updateAgent() without multiagent — roster must clear (empty coordinator)...
   ✅ remote roster cleared

=== Multi-Agent live probe (bailian) passed! ===

🧹 Cleanup (bailian) — destroy order is the reverse of creation
   🧹 removed session: sesn_01M34W2R2C6JFB30QE0ANY0ET6
   🧹 archived/deleted coordinator: agent_01M34W2QVVMFCB5VR2JB4CSQT5
   🧹 archived/deleted worker: agent_01M34W2QPZR96PV5FRZEVW75VS
   🧹 deleted environment: env_ZTEzMDg0ZmU4MGY3NDBkZj
```

`threaded=3` here reflects Bailian's mapper surfacing `session_thread_id` on child-thread events
(`thread_created`, `thread_message_sent`, `thread_message_received`), confirming real coordinator →
worker delegation in the run.

## External Managed Agent references — 2026-09-23

The Managed probes were rerun after extending `multiagent.agents` with `{ agent_id }`. In both
runs the probe created a temporary worker directly in the Provider, deliberately omitted it from
the coordinator's `ProjectConfig` and local state, and then resolved this declaration:

```yaml
multiagent:
  type: coordinator
  agents:
    - agent_id: <temporary-external-worker-id>
```

| Provider | Create/read-back | Real coordinator turn | Clear roster | Cleanup |
| --- | --- | --- | --- | --- |
| Qoder Managed | Passed; remote roster contained the external Agent id | Passed; child-Agent tool/thread events observed | Passed (`multiagent: null`) | Session, coordinator, external worker, and Environment removed |
| Bailian Managed | Passed; remote roster contained the external Agent id | Passed; 5 events carried child-thread ids | Passed (empty coordinator roster) | Session, coordinator, external worker, and Environment removed |

Commands:

```text
bun packages/sdk/tests/e2e/multiagent-live.ts qoder-managed
bun packages/sdk/tests/e2e/multiagent-live.ts bailian
```

Both commands exited with status 0. Credentials were loaded from the repository `.env`; no
credential values were logged or modified. Qoder Forward was not rerun for this extension because
the public schema intentionally rejects `{ agent_id }` for Forward rosters, which require
`template_id`.
