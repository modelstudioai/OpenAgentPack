# Private braces security backport

This directory vendors the official `braces@3.0.3` npm release under the private
identity `@openagentpack/braces@3.0.3-patch.1`. It is not an official upstream
release and must not be published. The original MIT license is preserved in
`LICENSE`; unchanged upstream files retain their original contents and style.

## Origin

- Official tarball: https://registry.npmjs.org/braces/-/braces-3.0.3.tgz
- npm integrity, verified against the downloaded bytes:
  `sha512-yQbXgO/OSZVD2IsiLlro+7Hf6Q18EJrKSEsdoMzKePKXct3gvD8oLcOQdIzGupr5Fj+EDe8gO/lxc1BzfMpxvA==`
- Upstream source and compatibility tests:
  https://github.com/micromatch/braces/tree/3.0.3
- Advisory: https://github.com/advisories/GHSA-vfj7-8cjw-p6xm
  (`CVE-2026-93687`). On 2026-10-15 npm still listed `3.0.3` as latest, and
  the advisory listed no patched version.
- Depth/cycle preflight design reviewed from upstream PR #88,
  https://github.com/micromatch/braces/pull/88/commits/a795ee83ecd011131b2d618fe754ac5a8e124dae
- Expansion queue isolation reviewed from upstream PR #82,
  https://github.com/micromatch/braces/pull/82/commits/ce0745dcc6bc534243efadf5cef567f62ba76851

Both PRs are unmerged proposals, not upstream releases. The local backport is
reviewed and maintained by OpenAgentPack. Its additional visit budget and input
shape checks are described below rather than being attributed to an upstream
release.

The vendored README uses absolute upstream links for files not included in this
source copy; the original documentation text is otherwise preserved.

## Local changes

- Parsing permits at most 128 nested brace/parenthesis containers, counting both
  kinds together, and throws `SyntaxError` before accepting the next container.
  This also covers unmatched opening delimiters and does not count escaped or
  quoted delimiters as containers. Callers cannot disable the limit.
- `compile`, `expand`, and `stringify` validate child edges iteratively before
  their recursive walkers run. The child-edge limit is 129: root depth zero,
  plus up to 128 containers and their final leaf. Child cycles are rejected.
  Normal parser `parent` and `prev` backlinks are deliberately not child edges.
- Shared acyclic children are permitted, but traversal is limited to 65,536
  node visits so repeatedly shared subtrees cannot make the preflight or walkers
  take exponential time. AST nodes must be objects, child lists must be arrays,
  and values, when supplied, must be strings, preventing nested arrays from
  entering the recursive expansion queues through a hand-built AST value.
- Expansion derives queue ownership from the actual validated child traversal.
  It does not trust caller-supplied `parent` backlinks or consume external
  queues. This prevents cycles or deeply nested external queues from bypassing
  the child-edge check. Generated work queues remain internal to the traversal.

The CommonJS API and `fill-range@^7.1.1` dependency are retained. Inputs beyond
the documented safety bounds now fail with a bounded `SyntaxError`; ordinary
patterns retain upstream behavior. Some malformed/unclosed patterns that previously
failed with a parent-queue TypeError now return a literal expansion. This backport addresses the specified
nesting/AST vulnerability, not every possible resource cost of brace expansion.

## Integration and verification

Use a root Bun override and an explicit development dependency:

```json
{
  "devDependencies": {"braces": "file:./vendor/braces"},
  "overrides": {"braces": "file:./vendor/braces"}
}
```

Both entries are needed with the repository's Bun 1.3.5: a clean install with
only the relative file override can write a lockfile entry but omit the package
and its dependencies. The direct dependency gives Bun a concrete local package
to install, while the override routes transitive users to the same patched copy.
Verify actual resolution through a transitive consumer as well as the lockfile;
an audit result alone does not prove that the runtime package was installed.

The package identity records the actual patched source; it is not a fabricated
official `braces` version or an audit-ignore rule. Keep the repository's normal
audit enabled. `scripts/braces-security.test.ts` covers all public recursive
entry points, hand-built deep/cyclic ASTs, shared nodes, parent metadata, and
ordinary ranges/empty/nested patterns.

Remove this vendor override once upstream publishes a reviewed fix that covers
these entry points; rerun the security tests, upstream compatibility suite,
dependency audit, and release verification against that replacement.
