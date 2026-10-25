# Dependency patch evidence, 2026-10-25

This change updates compatible dependency releases. It does not make the package
ready to publish: the audit still reports three high-severity package findings
covering two unresolved advisories.

| Package | Previous lock | Updated lock | Independent evidence |
| --- | --- | --- | --- |
| `body-parser` | 2.3.0 | 2.4.0 | [Compressed-body process crash](https://github.com/advisories/GHSA-27r3-jxmh-p828) |
| `fast-uri` | 3.1.8 | 3.1.9 | [Encoded-scheme confusion](https://github.com/advisories/GHSA-w74x-v6f9-j3xg) and related normalization fixes in this patch |
| `vite` | 8.2.2 | 8.3.5 | [Editor command execution](https://github.com/advisories/GHSA-587h-7wmj-h5pm) and related advisories reported by npm |
| `vitest`, `@vitest/coverage-v8`, `@vitest/mocker` | 4.1.11 | 4.1.12 | [Manual mock injection](https://github.com/advisories/GHSA-qxg6-89mg-rqv8), [Windows traversal](https://github.com/advisories/GHSA-xp26-3454-mjgp) |

The matching Vitest 4 packages retain their major version. Other lock changes are
their compatible transitive dependency resolutions. No Azure Identity, MSAL or Zod
override, downgrade, major upgrade, audit suppression, or release-gate bypass is
included.

## Assumption and counterexamples

A previously successful install or test run does not establish current dependency
safety. Before updating the lock, `dependency-security.test.ts` reproduced two
independently documented counterexamples:

- AJV's installed URI resolver converted `%6Aavascript:alert(1)` into a live
  `javascript:` scheme. The regression failed on the original lock.
- The SDK's Express helper processed a gzip JSON frame with trailing bytes and
  its child process terminated with an unhandled `Z_DATA_ERROR`. The regression
  failed on the original lock. The payload is reconstructed from upstream
  [body-parser commit 1260c38](https://github.com/expressjs/body-parser/commit/1260c38).

These checks exercise the installed libraries and a real localhost HTTP transport.
Hypervibe currently uses MCP stdio; reproducing a dependency defect does not prove
that Hypervibe exposes that HTTP attack path or establish a customer incident.
The patched resolver preserves the encoded input when normalizing, rejects it when
resolving, and no longer equates an encoded scheme with its decoded counterpart.
The HTTP child survives and returns the parsed JSON after the patch.

The regressions live under `src/__tests__` in the ordinary `npm test` path. Both
the committed acceptance workflow and desired acceptance command run `npm test`;
live branch-protection enforcement was not checked.

## Verification

On Node 24.18.1 with npm 11.19.0, a fresh `npm ci` completed after the lock repair.
A temporary user npm configuration allowed only the existing
`better-sqlite3@13.0.3` and `fsevents@2.3.3` install scripts; no global or committed
script policy changed. An in-memory SQLite query verified the native module.

`npm run typecheck` passed. Six focused test files passed with 49 tests using
`--coverage`, exercising the matched Vitest/coverage packages, dependency
regressions, CLI, MCP command contracts, JSON persistence codecs, strict desired
state schemas, and the managed recovery provider matrix. Both new dependency
regressions failed before the updates and passed afterward. A resolver assertion
was corrected during verification to expect rejection of the malformed scheme.

The fresh audit reports 3 high findings and no moderate findings, compared with
5 high and 4 moderate findings before the repair. The full acceptance suite,
release gate, live provider calls, and Windows-specific exploit reproductions
were not run for this partial dependency change.

## Remaining release blockers

- [MSAL authorization-code disclosure](https://github.com/advisories/GHSA-xcx6-jx8p-x3h5):
  fixed in MSAL 7.1.0+, outside the range declared by current Azure Identity.
  Latest stable Identity 4.14.0 still declares MSAL 6. Rolling back Identity to
  4.13.0 would remove subsequent safe credential-process execution changes; this
  requires deliberate compatibility review, not automatic audit repair.
- [Zod resource exhaustion](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5):
  fixed in the v4 implementation from 4.6.6. A real schema migration is required.
  An isolated package probe confirmed that Zod 4.6.7's `/v3` compatibility export
  still walks invalid oversized arrays, so changing the package version alone
  cannot establish remediation. The upstream fix covers bounded collections;
  [unbounded collections remain unchanged](https://github.com/colinhacks/zod/pull/6652).

Audit data is time-sensitive. Re-run `npm audit --audit-level=high` during the
eventual release gate; this partial repair is not a clean audit or a live-provider
compatibility claim.
