# Security Policy

## Supported Versions

OpenAgentPack is awaiting open-source approval and has no supported public release yet. Until the first release, security fixes land on `main`. After publication, fixes will target the latest `@openagentpack/cli`, `@openagentpack/sdk`, and `@openagentpack/playground` prerelease; reporters should reproduce against the latest available version when possible.

## Reporting a Vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, report privately through GitHub's [private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability): open the repository's **Security** tab and click **Report a vulnerability**.

Please include:

- A description of the vulnerability and its impact.
- Steps to reproduce, or a proof of concept.
- Affected package and version.
- Any suggested remediation, if you have one.

We aim to acknowledge reports within a few business days and will keep you updated on remediation progress. Please give us reasonable time to release a fix before any public disclosure.

## Handling Secrets

OpenAgentPack manages credentials as a first-class concern, so please keep these expectations in mind when reporting or contributing:

- **Secrets belong in the environment, not the config.** `agents.yaml` references secrets with `${VAR_NAME}` and resolves them from `.env` at runtime. Never commit resolved secret values.
- **`.env` and state files are gitignored** (`.env`, `.env.*`, `*.state.json`, `agents.state.json`). Do not force-add them, and do not paste their contents into issues, PRs, or logs.
- **Vault credentials are a security boundary.** They are managed by the provider and are not written into local state in plaintext. Report any code path that leaks a credential into logs, state, or telemetry.

If you believe a secret has been committed to the repository history, treat it as a vulnerability and report it privately.
