# Examples

OpenAgentPack config examples organized by provider.

## Directory structure

```
examples/
├── bailian/                     Bailian provider (Aliyun AgentStudio)
│   ├── basic/                   minimal agent + run-session.ts
│   ├── with-skills/             skill + file-referenced instructions
│   ├── official-skill/          official platform skill (referenced, not uploaded)
│   ├── with-mcp/                official MCP server (by name, no vault)
│   ├── with-files/              upload local files (Files API)
│   ├── with-vault/              vault
│   ├── bailian-cli/             Bailian CLI integration
│   ├── deployment/              schedule + file resources (emulated -> Session on run)
│   └── full/                    dev + staging dual-environment full stack
├── claude/                      Claude provider
│   ├── basic/                   minimal agent
│   ├── with-skills/             skill + file-referenced instructions
│   ├── with-mcp/                MCP server + vault + restricted network
│   ├── multiagent/              coordinator multi-agent (Claude only)
│   ├── multi-provider/          same agent on both Claude + Qoder
│   ├── deployment/              schedule + outcome rubric (native)
│   └── full/                    Claude full-feature stack
├── qoder/                       Qoder provider
│   ├── basic/                   minimal agent
│   ├── with-skills/             skill + file-referenced instructions
│   ├── with-mcp/                MCP server + vault + restricted network
│   ├── with-memory/             memory_store (Qoder only)
│   ├── with-vault/              vault only
│   ├── vault-only/              vault-only project
│   ├── multi-provider/          same agent on both Claude + Qoder
│   ├── deployment/              schedule + memory_store (native)
│   ├── bailian-cli/             Bailian CLI integration
│   └── full/                    Qoder full-feature stack
├── ark/                         Volcengine Ark provider (Managed Agents, doubao)
│   ├── basic/                   minimal agent
│   ├── with-skills/             skill (create + attach) + file-referenced instructions
│   ├── with-files/              upload local files (Files API)
│   ├── with-mcp/                MCP server + vault + restricted network
│   ├── multiagent/              coordinator multi-agent
│   ├── deployment/              schedule + file resources (emulated -> Session on run)
│   └── full/                    memory_store (native) + dual-environment full stack
└── runtime/                     runtime examples (create Session + stream response)
    ├── run-session.ts           simple conversation
    └── run-session-complex.ts   tool calls + streaming events
```

## Provider capability matrix

| Feature | Bailian | Qoder | Claude | Volcengine Ark | Notes |
|---------|:-------:|:-----:|:------:|:--------------:|-------|
| Environment | native | native | native | native | All four providers expose cloud environments. |
| Vault | native | native | native | native | All four manage credentials through their vault APIs. |
| Skill | native | native | native | native | Claude uploads via `files[]`; others upload zip; Volcengine Ark is create + attach only. |
| Agent | native | native | native | native | Core managed-agent resource. |
| MCP Server | native | native | native | native | Bailian uses official managed servers referenced by name. |
| Memory Store | unsupported | native | unsupported | native | Qoder and Volcengine Ark. |
| Multi-Agent | unsupported | unsupported | native | native | Claude and Volcengine Ark support coordinator. |
| Deployment | emulated | native | native | emulated | Qoder and Claude schedule server-side; Bailian and Ark expand into a session at `run` time. |
| Session | native | native | native | native | All four support runtime sessions. |

## Tool naming differences

| Function | Config (lowercase) | Qoder native |
|----------|--------------------|--------------|
| Read file | `read` | `Read` |
| Find files | `glob` | `Glob` |
| Search content | `grep` | `Grep` |
| Fetch web page | `web_fetch` | `WebFetch` |
| Web search | `web_search` | `WebSearch` |
| Write file | `write` | `Write` |
| Edit file | `edit` | `Edit` |
| Shell | `bash` | `Bash` |

> Write tools lowercase in config (`defaults.provider: all`) and they are converted automatically when applying to Qoder. Bailian and Claude use lowercase natively.

## Quick start

```bash
agents init                       # interactive init
agents validate                   # offline validation
agents plan                       # preview the plan
agents plan --provider bailian    # Bailian's plan only
agents plan --provider qoder      # Qoder's plan only
agents plan --provider claude     # Claude's plan only
agents plan --provider ark        # Volcengine Ark's plan only
agents apply                      # apply changes
agents apply -y                   # skip confirmation
agents destroy                    # destroy all resources
agents state list                 # list managed resources

# Session management (runtime)
agents session create assistant   # create a session for an agent
agents session list               # list all sessions
agents session list --agent assistant  # filter by agent
agents session get sess_abc123    # session detail
agents session delete sess_abc123 # delete a session
```
