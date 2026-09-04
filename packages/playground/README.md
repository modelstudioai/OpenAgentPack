# `@openagentpack/playground`

A one-command local WebUI for [OpenAgentPack](https://github.com/modelstudioai/OpenAgentPack).

The CLI fetches the matching Playground version on demand the first time you start it:

```sh
agents playground -f agents.yaml
agents project workbench --project ./my-agent
```

Both commands launch the same loopback-only local API and WebUI, but they have different sources. `agents playground` keeps the standalone `agents.yaml` Session Preview. `agents project workbench` opens a directory project, watches its complete source tree, edits existing JSON/Markdown declarations, previews and writes Build output, publishes the reviewed Build, and browses or restores full source snapshots.

Session Preview never writes YAML. Directory Workbench writes authored source only after explicit save or restore; generated YAML is written only by Build. Providers cannot be edited in the UI, and Deployment declarations are shown read-only but included in full project Publish. Temporary Session attachments and remote State remain outside version snapshots.

If the configuration is missing or invalid, the workbench still opens with diagnostics and automatically recovers after an external edit. Existing Sessions in the same server process keep their original runtime snapshot while new Plans, Applies, uploads, and Sessions remain disabled.

For configuration and provider setup, see the [project documentation](https://github.com/modelstudioai/OpenAgentPack#readme).

## License

Apache-2.0. See the [repository license](https://github.com/modelstudioai/OpenAgentPack/blob/main/LICENSE).
