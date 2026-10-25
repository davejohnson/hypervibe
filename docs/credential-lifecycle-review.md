# Credential lifecycle review map

Review the change in the following three dependency-ordered phases. Each has its
own behavioral contract and focused acceptance surface. These are review units,
not three published pull requests. The implementation reuses existing encrypted
plans, audit records, connection storage, environment/component bindings and
managed rollout state.

| Phase | Contract and implementation entry points | Required focused regressions |
| --- | --- | --- |
| 1. Read-only inventory | `src/application/credential-inventory.ts`; shared `hv_secrets` command; GitHub scope inventory; [inventory contract](credential-inventory.md). Inspect existing evidence without adoption, generation, repair, audit writes or value disclosure. | `credential-inventory.test.ts`, `github.secret-inventory.api-contract.test.ts`; actual CLI/MCP envelopes, empty secret declarations, exact repository/environment scope, deleted environments, aliases, candidates, unknown rotation dates and no-write assertions. |
| 2. Explicit adoption and provenance | `src/domain/spec/credential.schema.ts`, spec validation, `credential-runtime-consumers.ts`, adoption in `credential-lifecycle.service.ts`, connection audit and existing encrypted owner-request recovery; [tracking contract](credential-lifecycle.md). A reviewed declaration selects one source, role, identity and exact consumers. Adoption preserves values. | Adoption/source cases in `credential-lifecycle.test.ts`; `credential-mapping.test.ts`, `connections.tools.test.ts`, `cloud-secret-import.test.ts`; unchanged provider values, rejected differing candidates, source pickup/import/acceptance timestamps, account mismatch and generated ownership. |
| 3. Rotation, recovery and verification | `credential-plan.contract.ts`, `credential-lifecycle.service.ts`, `database-password-rotation.service.ts`, registered native capabilities, `runtime-rollout.service.ts`, GitHub/GitLab managed producers and `credential-operation-verification.ts`. Existing spec → plan → apply → rollout → status/health remains the only mutation path. | `credential-all-hosting.test.ts`, `credential-lifecycle.test.ts`, `credential-registry.integration.test.ts`, `database-password-rotation.test.ts`, `runtime-rollout.service.test.ts`, GitHub/GitLab activation suites and `credential-operation-verification.test.ts`; real adapter transports, emitted operational programs and disposable PostgreSQL authentication. |

The test basenames above are unique; locate them with `rg --files src test`.
All are included by the ordinary `npm test` configuration. The committed
`Hypervibe / acceptance` workflow runs that command and `npm run typecheck`;
`.hypervibe/spec.json` declares that acceptance check required. Repository
configuration does not establish the live branch-protection setting.

## Assumptions challenged and counterexamples

| Assumption | Independent expectation and failing counterexample | Verification boundary |
| --- | --- | --- |
| A matching name/value identifies the same credential. | The requested role/source mapping is authority. Equal undeclared values and similarly named keys on different services remain independent. | Real application inventory, SQLite, dotenv files and serialized MCP/CLI results. |
| Picking up a file or importing a connection proves rotation. | The requested evidence model separates source read, provider dates, user dates, acceptance, validation and activation. A newly read old key still has unknown rotation dates. | Source/reference/import regressions failed before provenance persistence; read-only projection then passed without exposing values or private fingerprints. |
| One successful write means synchronization is complete. | Exact reviewed aliases and scopes all need outcomes. A successful first alias followed by a lost acknowledgement leaves recovery pending and retains the frozen replacement. | Shared plan/apply and encrypted persistence; readback, write-only acknowledgement, uncertain-write and interruption cases. |
| A successful deployment proves the replacement is running everywhere. | Exact new deployment identity and old-consumer coverage are required. A successful new revision alongside an active old revision remains pending. | Native adapter observations and executed managed release producers; traffic coverage remains distinct from instance retirement. |
| A new Fly Machine instance always uses newly staged secrets. | [Fly's native contract](https://community.fly.io/t/flyctl-update-for-managing-secrets/25878/1) requires `min_secrets_version`; without it a new instance may load cached values. | Accepted version is carried through the native update and operation-bound release artifact; missing or mismatched version fails activation. |
| Updating a database environment variable changes authentication. | [PostgreSQL ALTER ROLE](https://www.postgresql.org/docs/current/sql-alterrole.html) changes actual authentication. A server can continue accepting the old password after configuration-only edits. | Real disposable PostgreSQL: old password initially works, configuration-only edit fails, native password change accepts the replacement and rejects the old password on fresh connections; an existing session remains usable. |
| Authentication or a homepage response proves the application operation. | The requested outcome distinguishes Anthropic authentication from invoice extraction and SendGrid permissions from delivery. Wrong operation/deployment receipts or failed business assertions cannot reuse older success. | Declared HTTP/task receipts through the shared health command, exact accepted operation ID, deployment identity and bounded business counts. |

Each regression was exercised as a failing counterexample before its runtime
fix, or with the relevant protection disabled as a negative control for an
already-integrated path. Provider fixtures are labeled reconstructed/synthetic
and use official contracts; they are not live captures. See the detailed
[runtime](runtime-credential-providers.md), [database](database-credential-rotation.md),
[registry](credential-registry-rotation.md), [webhook](stripe-webhook-credential-rotation.md)
and [operation](credential-operation-verification.md) evidence records.

## Review and verification limits

This PR is extracted onto current main, preserving its merged security and
repository-scope fixes and excluding unrelated bootstrap, storage, recovery and
macOS changes. Verification uses the ordinary `npm test` and `npm run typecheck`
commands against this extracted source and main’s locked dependencies. The PR
records the final executed results. The earlier integrated-worktree test result
is not substituted for validation of this branch.

No cloud credential was rotated during development. Offline transport tests and
the local PostgreSQL check establish the boundaries they execute. A user's live
apply must still establish account permissions, provider convergence and the
application's declared operation. The resulting configuration, deployment,
authentication, operation and retirement evidence are reported separately.
