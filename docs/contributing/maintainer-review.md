# Maintainer review

OpenAgentPack welcomes exploratory and AI-assisted contributions. The merge bar is based on evidence, not on who wrote the code or how it was produced.

## Review in this order

1. Read **Summary**, then **Behavior / risk** and **Validation** when present.
2. Confirm that CI covers the claimed behavior. A passing test is useful only if it would fail when the stated contract regresses.
3. Read the diff around provider, configuration, credentials, release, and workflow boundaries. These paths have the greatest blast radius.
4. Resolve every conversation, then approve only the latest commit.

## Gate levels

| Change | Automated gate | Human review |
| --- | --- | --- |
| Documentation, examples, small isolated fixes | `Gate` | Scope and user-facing accuracy |
| CLI or SDK behavior | `Gate` | Contract plus a regression test or reproduction |
| Provider contracts, config/schema, release/package files, workflows | `Gate` plus CodeQL | Behavior/risk and validation evidence; inspect compatibility and security impact |

The PR evidence check deliberately applies only to the third row. It does not require a design document, a linked Issue, or an AI-use declaration.

## GitHub settings

Configure `main` with these required checks: `Gate` and `Analyze TypeScript`. Require one approving review, dismiss stale approvals, require approval of the most recent push, require conversations to be resolved, and require branches to be up to date. Keep linear history enabled. Do not require CODEOWNERS review or a merge queue until review volume makes them worthwhile.

## Fast disposition

If a PR does not yet provide enough evidence, ask for one focused thing: a failing regression test, a runnable reproduction, or a clear statement of the intended behavior. If the author cannot provide it, keep the PR open as a Draft or close it with an invitation to reopen when the evidence is available.
