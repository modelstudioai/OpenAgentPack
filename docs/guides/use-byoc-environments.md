# Use BYOC environments

Use a bring-your-own-cloud (BYOC) environment when an administrator has already provisioned a self-hosted Qoder environment and, optionally, a tunnel to private services. OpenCMA references those resources; it does not own their lifecycle.

## Prerequisites

Ask the environment administrator for:

- an environment ID, such as `env_00xxxx`;
- a tunnel ID, such as `tnl_00xxxx`, when the agent needs access to private services;
- the Qoder credentials needed to manage the agent and start sessions.

Do not commit real IDs, private hostnames, or credentials. Use environment variables for credentials and keep live deployment configurations outside the repository.

## Configure the external resources

Declare the provisioned environment with `environment_id` and `self_hosted`. Declare a tunnel by its existing ID, then reference both from the agent.

```yaml
version: "1"

providers:
  qoder:
    api_key: ${QODER_PAT}

defaults:
  provider: qoder

environments:
  byoc-environment:
    environment_id: env_00xxxx
    config:
      type: self_hosted

tunnels:
  internal-network:
    tunnel_id: tnl_00xxxx

agents:
  private-service-assistant:
    model: qmodel_latest
    instructions: You can use the configured private services.
    environment: byoc-environment
    tunnel: internal-network
    tools:
      builtin: [Bash, Read]
```

`tunnel` is supported only for Qoder BYOC sessions and deployments. Omit the entire `tunnels` section and the agent's `tunnel` field when no private-network tunnel is needed.

## Apply and run

Apply the configuration to provision or update managed resources such as the agent. The declared environment and tunnel are only recorded as references.

```bash
agents apply -f agents.yaml
agents session run "Check the private service status" --agent private-service-assistant -f agents.yaml
```

You can override the configured IDs for a one-off session without changing the YAML:

```bash
agents session run "Check the private service status" \
  --agent private-service-assistant \
  --environment-id env_00xxxx \
  --tunnel-id tnl_00xxxx \
  -f agents.yaml
```

## Lifecycle and cleanup

When `environment_id` is present, OpenCMA never creates, updates, or remotely deletes that environment. Tunnels are always references and are never managed by OpenCMA.

OpenCMA records external ownership in its local state. If you later remove the environment declaration and run `agents apply`, it removes only the local state record; the administrator-managed environment remains intact. The same protection applies to `agents destroy`.

Deleting an agent, session, vault, or other managed resource still follows its normal lifecycle. Use the provider's administrator tooling to modify or delete BYOC environments and tunnels.

## Troubleshooting

| Symptom | Check |
|--------|-------|
| Session cannot reach a private service | Confirm the supplied tunnel ID is enabled for the environment and that the service hostname is reachable from the private network. |
| `Tunnel '...' is not defined in config` | Add the name under `tunnels`, or pass `--tunnel-id` for a one-off session. |
| Tunnel unsupported diagnostic | Ensure the agent or deployment targets Qoder; tunnels are not sent to other providers. |
| Environment cannot be resolved | Verify the administrator-provided `environment_id` and the agent's `environment` reference. |

For field definitions, see the [configuration reference](../reference/configuration.md).
