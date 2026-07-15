# Use skills

A **skill** is a reusable capability module. OpenAgentPack uploads it from a local directory and attaches it to one or more agents.

## Author a skill

A skill is a directory with a `SKILL.md` (and any supporting files). Declare it at the top level:

```yaml
skills:
  code-review:
    source: ./skills/code-review/
    description: "Structured code review with severity levels"
```

| Field | Required | Description |
|-------|:--------:|-------------|
| `source` | yes | Path to the skill directory (relative to the config file). |
| `description` | no | Human-readable summary. |
| `version` | no | Skill version label. |
| `origin` | no | `custom` (default for uploaded skills) or `official`. |
| `provider` | no | Pin a skill to one provider in a multi-provider config. |

## Attach a skill to an agent

By name (string):

```yaml
agents:
  reviewer:
    skills: [code-review]
```

Or by explicit reference (`{ type, skill_id, version }`):

```yaml
agents:
  reviewer:
    skills:
      - type: custom
        skill_id: code-review
```

## Official skills (Bailian)

Bailian hosts platform-provided skills you reference **without uploading or managing** — OpenAgentPack only references them:

```yaml
agents:
  presentation-helper:
    skills:
      - type: official
        code: pptx
        version: "1.0"
```

The skill is not created, updated, uploaded, or deleted by OpenAgentPack; it is only referenced. See [`examples/bailian/official-skill/`](../../examples/bailian/official-skill/).

## Provider notes

- **Claude** uploads skills via `files[]`.
- **Qoder, Bailian, Ark** upload skills as a zip archive.
- **Ark** supports create + attach + get only (no update/delete).

## Verification

```bash
agents validate       # confirm the skill source resolves
agents plan           # the skill appears as a create on first apply
agents apply -y
```

## Examples

- [`examples/claude/with-skills/`](../../examples/claude/with-skills/)
- [`examples/bailian/official-skill/`](../../examples/bailian/official-skill/)
- [`examples/ark/with-skills/`](../../examples/ark/with-skills/)
