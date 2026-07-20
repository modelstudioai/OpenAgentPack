# Examples

The [`examples/`](../examples) directory has runnable configs for every provider, indexed below by what you want to do. Each directory contains an `agents.yaml` you can copy and adapt.

## By goal

| I want to… | Example |
|------------|---------|
| Deploy a minimal agent | [`examples/bailian/basic/`](../examples/bailian/basic/) · [`examples/claude/basic/`](../examples/claude/basic/) · [`examples/qoder/basic/`](../examples/qoder/basic/) · [`examples/ark/basic/`](../examples/ark/basic/) |
| Attach a skill | [`examples/bailian/with-skills/`](../examples/bailian/with-skills/) · [`examples/claude/with-skills/`](../examples/claude/with-skills/) · [`examples/qoder/with-skills/`](../examples/qoder/with-skills/) · [`examples/ark/with-skills/`](../examples/ark/with-skills/) |
| Use an official (platform) skill | [`examples/bailian/official-skill/`](../examples/bailian/official-skill/) |
| Connect an MCP server + vault | [`examples/claude/with-mcp/`](../examples/claude/with-mcp/) · [`examples/qoder/with-mcp/`](../examples/qoder/with-mcp/) · [`examples/ark/with-mcp/`](../examples/ark/with-mcp/) |
| Use an official MCP server | [`examples/bailian/with-mcp/`](../examples/bailian/with-mcp/) |
| Use a vault | [`examples/bailian/with-vault/`](../examples/bailian/with-vault/) · [`examples/qoder/with-vault/`](../examples/qoder/with-vault/) |
| Connect a credential-based IM Channel | [`examples/qoder/with-channel/`](../examples/qoder/with-channel/) |
| Use memory stores | [`examples/qoder/with-memory/`](../examples/qoder/with-memory/) · [`examples/claude/with-memory/`](../examples/claude/with-memory/) · [`examples/ark/full/`](../examples/ark/full/) · [runtime lifecycle](../examples/memory/README.md) |
| Upload local files (Files API) | [`examples/bailian/with-files/`](../examples/bailian/with-files/) · [`examples/ark/with-files/`](../examples/ark/with-files/) |
| Coordinate multiple agents | [`examples/claude/multiagent/`](../examples/claude/multiagent/) · [`examples/ark/multiagent/`](../examples/ark/multiagent/) |
| Deploy to multiple providers | [`examples/claude/multi-provider/`](../examples/claude/multi-provider/) · [`examples/qoder/multi-provider/`](../examples/qoder/multi-provider/) |
| Schedule a deployment | [`examples/bailian/deployment/`](../examples/bailian/deployment/) · [`examples/claude/deployment/`](../examples/claude/deployment/) · [`examples/qoder/deployment/`](../examples/qoder/deployment/) · [`examples/ark/deployment/`](../examples/ark/deployment/) |
| Run everything end-to-end | [`examples/bailian/full/`](../examples/bailian/full/) · [`examples/claude/full/`](../examples/claude/full/) · [`examples/qoder/full/`](../examples/qoder/full/) · [`examples/ark/full/`](../examples/ark/full/) |

## Runtime (sessions from code)

| Script | What it does |
|--------|--------------|
| [`examples/runtime/run-session.ts`](../examples/runtime/run-session.ts) | Create a session against deployed infrastructure and stream the response. |
| [`examples/runtime/run-session-complex.ts`](../examples/runtime/run-session-complex.ts) | Tool calls and streaming events. |

## Run an example

```bash
cd examples/bailian/basic
cat > .env <<'EOF'
DASHSCOPE_API_KEY=sk-...
BAILIAN_WORKSPACE_ID=llm-...
EOF
agents validate
agents plan
agents apply -y
agents session run "Hello" --agent assistant
agents destroy
```

## Provider capability matrix

| Feature | Bailian | Qoder | Claude | Volcengine Ark |
|---------|:-------:|:-----:|:------:|:--------------:|
| Environment | native | native | native | native |
| Vault | native | native | native | native |
| Skill | native | native | native | native |
| Agent | native | native | native | native |
| MCP Server | native | native | native | native |
| Memory Store | unsupported | native | native | native |
| Multi-Agent | unsupported | unsupported | native | native |
| Deployment | emulated | native | native | emulated |
| Session | native | native | native | native |

See [Provider reference](./reference/providers.md) for per-provider configuration and notes.
