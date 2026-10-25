# Dependency security evidence, 2026-10-25

This change repairs all findings in the reviewed dependency graph, including the
Zod and Azure/MSAL findings that remained after the initial compatible updates.
The development tree reports zero vulnerabilities after a fresh `npm ci`.
Package delivery is verified separately: an npm override alone does not protect
users installing Hypervibe through npm or `npx`.

| Package | Previous lock | Updated lock | Independent evidence |
| --- | --- | --- | --- |
| `body-parser` | 2.3.0 | 2.4.0 | [Compressed-body process crash](https://github.com/advisories/GHSA-27r3-jxmh-p828) |
| `fast-uri` | 3.1.8 | 3.1.9 | [Encoded-scheme confusion](https://github.com/advisories/GHSA-w74x-v6f9-j3xg) |
| `vite` | 8.2.2 | 8.3.5 | [Editor command execution](https://github.com/advisories/GHSA-587h-7wmj-h5pm) |
| `vitest`, coverage and matching packages | 4.1.11 | 4.1.12 | [Manual mock injection](https://github.com/advisories/GHSA-qxg6-89mg-rqv8), [Windows traversal](https://github.com/advisories/GHSA-xp26-3454-mjgp) |
| `zod` | 3.25.76 | 4.6.7 | [Collection validation resource exhaustion](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5), [upstream fix](https://github.com/colinhacks/zod/pull/6652) |
| Azure Identity's `@azure/msal-node` | 5.5.0 | 7.1.1 | [Authorization-code origin validation](https://github.com/advisories/GHSA-xcx6-jx8p-x3h5), [upstream fix f550958](https://github.com/AzureAD/microsoft-authentication-library-for-js/commit/f550958) |

## Real Zod v4 migration

Changing only the installed version would be insufficient: the patched package's
`zod/v3` compatibility export retains the old collection traversal. Hypervibe uses
v4 schemas throughout; the MCP SDK recognizes those schemas and uses its v4 path.

Before the update, a production task-command schema with a 16-element limit
visited all 1,024 invalid elements, accumulating 1,025 issues. The shared command
response grew to 36,327 bytes and its serialized MCP response to 56,436 bytes.
Three regressions failed on v3 and pass on v4: the actual schema, command registry,
and JSON-round-tripped SDK transport now reject that oversized array with one
collection error, and a following valid request remains usable.

The migration also preserves application semantics. Three compatibility tests
passed on v3, failed immediately after upgrading, and passed after adapting the
schemas: omitted collaboration/environment-file settings stay omitted, nested
defaults still materialize without enabling mandatory reviews, and credential
forms still inspect refined/wrapped schemas. Explicit string-key records, public
wrapper APIs, and `prefault` preserve behavior documented by the
[official migration guide](https://zod.dev/v4/changelog). No v3 escape hatch,
private parse flags, relaxed strict-object validation, or broad `any` casts are used.

The upstream fix covers constrained collections, not every possible validation
resource-exhaustion case. It explicitly leaves unbounded collections unchanged.
Hypervibe does not invent resource-count limits for projects as part of this
migration. Existing SDK stdio and hosted-spec byte limits remain in place.

## Azure compatibility and delivery

No reviewed stable or beta Azure Identity release declares patched MSAL 7 yet.
Identity 4.13.2 is pinned to retain its structured credential-process execution,
with a narrowly scoped override selecting MSAL 7.1.1. Microsoft's
[v6](https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/lib/msal-node/docs/v6-migration.md)
and [v7](https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/lib/msal-node/docs/v7-migration.md)
migration guides locate the breaking changes in interactive browser-loopback
behavior. Hypervibe uses `DefaultAzureCredential`.

The real MSAL regression originally routed an authorization-code POST and a
synthetic client secret to a different, unconfigured Microsoft cloud origin.
It failed on 5.5.0 and passes on 7.1.1. Eight SDK tests additionally cover state
validation, explicit/environment credentials, cached tokens, terminal
configuration failures, workload assertions, managed identity and structured
CLI execution. Only HTTP/process boundaries are substituted; no live Azure
sign-in or credential is used.

[npm considers overrides only in the root project](https://docs.npmjs.com/cli/v11/configuring-npm/package-json#overrides).
A fresh-consumer experiment also rejected shrinkwrap as a fix: npm selected
vulnerable MSAL 5.6.0 despite the publisher's reviewed lock. Hypervibe therefore
uses npm's standard `bundleDependencies` for the tested Identity dependency
closure. No vendor source or manifest is patched. The published-package tests
extract the actual tarball and resolve MSAL from its embedded Identity package,
ensuring that the fixed dependency is delivered rather than supplied by the
development checkout. The extracted runtime smoke preserves that bundled copy.

**Compatibility limitation:** consumer `npm ls --all` can report MSAL 7 as outside
Identity's declared `^5.1.5` range. This is the deliberate, tested major override,
not an upstream compatibility guarantee. Fresh installation, actual resolution,
audit results, and SDK behavior are separate checks. Remove the override and
bundle when an upstream Identity release declares patched MSAL and passes these
contracts; do not downgrade Identity or alter vendor manifests to hide the warning.

## Other regressions and verification

Two additional tests failed before the compatible updates and pass afterward:
AJV's installed URI resolver no longer turns an encoded scheme into `javascript:`,
and the SDK Express child survives a compressed JSON body with trailing bytes.
The latter reconstructs [body-parser's upstream fixture](https://github.com/expressjs/body-parser/commit/1260c38)
through actual localhost HTTP. Hypervibe currently uses MCP stdio, so this does
not establish exposure of that HTTP path or a customer incident.

All regressions remain in the ordinary `npm test` path used by committed acceptance
CI and desired acceptance commands. Live branch-protection enforcement is not
inferred from those files. Windows-specific exploits, live provider authentication,
and universal credential-chain compatibility are not established by offline tests.

A fresh install on Node 24.18.1 and npm 11.19.0 used a temporary user configuration
allowing only the existing `better-sqlite3@13.0.3` and `fsevents@2.3.3` install
scripts; no global script policy changed. The audit gate is unchanged and no
advisory is suppressed. Re-run the audit during release because advisory data can
change independently of source. The full suite passed 6,145 tests (five skipped, one todo), followed by passing
typecheck, build and prepublish checks. A required OAuth fixture field was
corrected after that run; both affected Azure suites (17 tests) and typecheck
passed again. The built Hypervibe tarball installed into a fresh consumer with
no consumer overrides, reported zero audit findings, resolved Zod 4.6.7 and
bundled MSAL 7.1.1, and passed the real stdio smoke for all 23 tools across four
client profiles. Its `npx --no-install` skill-status command also succeeded.
An independent repeat installation preserved patched MSAL and the zero audit.
These are local/packaged receipts, not publication or live-provider claims.
