# `@openagentpack/playground`

A one-command local WebUI for [OpenAgentPack](https://github.com/modelstudioai/OpenAgentPack).

The CLI fetches the matching Playground version on demand the first time you start it:

```sh
agents playground -f agents.yaml
agents workbench -f agents.yaml
```

Both commands launch the same loopback-only local API and WebUI. `agents playground` opens a single Agent directly in Preview (use `--agent <id>` for multi-Agent projects), while `agents workbench` opens the project console without creating a Session. The selected `agents.yaml` is the only source of truth: Playground lists its Agents, watches referenced local files, previews and applies one Agent's runtime resources, and starts pinned debugging Sessions with live events and artifacts. Workbench automatically initializes local Git with an initial `agents.yaml` commit when needed and enables the same checkout-local version switch used by the CLI. When enabled, successful Apply commits dirty YAML; Versions toggles that switch and browses or restores commits. It never versions State or operates a remote repository. Missing, invalid, or empty projects open the diagnostic Workbench.

Session Preview never writes YAML. Workbench writes `agents.yaml` only after an explicit resource save or version restore; Providers and models cannot be overridden globally in the UI, and Deployment declarations are shown read-only. Temporary Session attachments are kept outside `agents.yaml` and `agents.state.json`; delete them explicitly from the workbench to remove the remote file.

If the configuration is missing or invalid, the workbench still opens with diagnostics and automatically recovers after an external edit. Existing Sessions in the same server process keep their original runtime snapshot while new Plans, Applies, uploads, and Sessions remain disabled.

For configuration and provider setup, see the [project documentation](https://github.com/modelstudioai/OpenAgentPack#readme).

## License

Apache-2.0. See the [repository license](https://github.com/modelstudioai/OpenAgentPack/blob/main/LICENSE).
