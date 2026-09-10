# September 2026 provider regression audit

Initial audit: `7c63032`, Hypervibe `0.1.24`. Hardening integrated onto
`1e928df` after PRs #189, #191, and #192 merged. Review window: September 2–9
(local time). This is an offline code and contract audit, not live certification.

## Findings fixed in this batch

1. **Binding exports could write into an unrelated checkout.**
   `writeRepoBindingsForEnvironment` checked the project name only when a
   bindings file already existed. A spec-less repository with a different
   remote could receive the selected project's provider identities. Reproduced
   using a disposable Git repository. Exports now require matching project
   evidence, reuse normalized remote matching, and require the exact known
   remote even when the directory or spec has the same project name. The guard
   applies to deletion as well as creation. Local provider identity remains
   available when no matching checkout exists.

2. **Failed live-test cleanup discarded recovery state.**
   The basic hosting/database/cache runner removed its workspace in `finally`,
   including `.hypervibe-data`, even when teardown threw. Its fallback cleanup
   also lacked the main test's subsequent plan verification. Both paths now
   share teardown verification; failed, blocked, pending, and incomplete work
   preserve the workspace and print its non-secret recovery location. Offline
   tests exercise the actual runner hooks with simulated child processes.

3. **An obsolete domain/DNS mutation path remained in service bootstrap.**
   Both production callers explicitly removed `domain`, but the bootstrap
   module still contained a separate provider attachment and Cloudflare write
   implementation. Deleted that module, its parameter plumbing, and tests of
   the unreachable path. Active domain lifecycle tests remain. Service
   bootstrap can no longer acquire domain authority through this parameter.

4. **Older runtimes accepted unknown newer database schemas.** A disposable
   database with a future migration marker was accepted by `migrate()`. Startup
   now rejects newer schemas before applying any pending migrations and directs
   the operator to update Hypervibe. Regression coverage preserves migration
   history and existing environment identity on rejection. This protects future
   upgrades once installed; it cannot retrofit already-published older runtimes.

Runtime changes remove **133 net lines**. Upgrade fixtures and regression
tests are counted separately from runtime code. The pre-existing user edit to
`AGENTS.md` is outside this branch. No dependencies or public commands were added.

## Recent pull requests and recurring causes

| PR | Change | Audit conclusion |
| --- | --- | --- |
| [179](https://github.com/davejohnson/hypervibe/pull/179), [180](https://github.com/davejohnson/hypervibe/pull/180) | macOS child IPC and lock handoff | Platform-specific failures escaped the preceding release checks; these require companion tests, not provider mocks. |
| [181](https://github.com/davejohnson/hypervibe/pull/181) | Workspace selection and honest logs | Shared interface boundaries need contract coverage independent of adapter tests. |
| [182](https://github.com/davejohnson/hypervibe/pull/182) | Broad provider lifecycle parity | Established implementation and mocked safety evidence; explicitly did not establish live support. |
| [183](https://github.com/davejohnson/hypervibe/pull/183) | SendGrid inbound routing | Nested domain/parent-zone behavior needs realistic project fixtures. |
| [184](https://github.com/davejohnson/hypervibe/pull/184) | Bound Railway database observation | Existing service-backed databases and flattened legacy scope differ from fresh provisioning fixtures. |
| [185](https://github.com/davejohnson/hypervibe/pull/185) | Env templates and generated secrets | Repository identity, derived-file failure, and binding-only retries are part of the lifecycle contract. |
| [186](https://github.com/davejohnson/hypervibe/pull/186), [187](https://github.com/davejohnson/hypervibe/pull/187) | Railway nullable counts and bucket recovery | Provider response shape and uncertainty need independent evidence; successful mocked creates did not establish API compatibility. |
| [188](https://github.com/davejohnson/hypervibe/pull/188), [190](https://github.com/davejohnson/hypervibe/pull/190) | Scoped deletion and service tombstones | Retry fixtures must include partially deleted provider resources and cross-environment identities. |
| [189](https://github.com/davejohnson/hypervibe/pull/189) | Railway response compatibility and legacy scope | Merged and included in the integration baseline; combined Railway and hardening tests pass. |
| [192](https://github.com/davejohnson/hypervibe/pull/192) | Railway deletion-marker observation | The integrated offline suite exposed a stale shared database-parity fixture missing `deletedAt`. Fixed its present-instance response without weakening the safety assertion. |
| [191](https://github.com/davejohnson/hypervibe/pull/191) | Immutable generated secrets | Merged and included in the integration baseline; accepted pre-immutable generated-secret provenance is tested across restart. |

The September 1 release through the reviewed checkout added a net 16,756 lines
under `src`, excluding test files and test directories. The highest-churn
runtime files are the Railway adapter, apply handler, and diff engine. This
supports smaller fixes and deleting duplicate paths rather than another broad
provider abstraction or parity rewrite.

## Provider evidence matrix

All 27 lifecycle slices below are `ready-for-live` in the checked-in matrix.
Their adapter and matrix tests passed in the baseline audit. None was promoted
to `supported`; no provider resources were provisioned or destroyed in this audit.

| Family | Providers |
| --- | --- |
| Hosting (7) | Railway, Cloud Run, ECS Express, Azure Container Apps, DigitalOcean, Vercel, Fly |
| PostgreSQL (8) | Railway, Supabase, Cloud SQL, RDS, DigitalOcean, Fly, Azure PostgreSQL, Neon |
| Cache (5) | Railway, Memorystore, ElastiCache, DigitalOcean, Azure Managed Redis |
| Object storage (4) | Railway, S3, GCS, Azure Blob |
| Queue (2) | Cloud Run/Pub/Sub; Railway application-managed PostgreSQL queue wiring |
| Edge load balancing (1) | Cloudflare |

The adapter test selection also covered GitHub, GitLab, Cloudflare DNS,
SendGrid, Twilio, Stripe, App Store Connect, OpenAI connection handling, and
secret-manager adapters. Passing these tests is evidence about the mocked
contracts, not every vendor feature or currently issued credential.

## Integration and upgrade regressions

- The hardening patch applies cleanly on top of merged #189, #191, and #192.
  Combined validation caught and corrected the shared parity fixture omitted
  from #192's provider-local test updates. The provider observation contract
  continues to reject a missing deletion marker.
- A frozen SQL fixture is derived from the schema-6 boundary in release
  `0.1.18`'s migration definitions, not regenerated from current migrations.
  Synthetic rows cross generic Railway binding migration, lazy spec conversion,
  database credential encryption, and apply-lock migration. After reopening,
  provider identities reconcile to noops, CI provider selection and the release
  contract hash remain stable, and private component values remain encrypted.
- Persisted plans loaded after restart reject a newer spec revision and newly
  observed masked keys before invoking any mutation handler.
- Generated-secret provenance using the pre-immutable `0.1.24` shape survives
  database/key-store restart and a complete plan/apply without provider writes.

## Remaining work before claiming provider reliability

- **Expand customer-shaped upgrade fixtures.** The frozen schema and restart
  tests above exercise actual persisted state, but do not cover every historical
  installation. Add value-free specs and bindings from relevant releases,
  migrate disposable SQLite copies, and verify import → plan → noop/status,
  stale-plan rejection, generated-secret provenance, and managed CI file drift.
  Include fresh checkout recovery and a second operator with existing cache state.
- **Complete import round trips.** The shared database parity suite runs against
  Railway, Supabase, Cloud SQL, RDS, and Fly, but its common scenarios focus on
  unknown observation, duplicates, absence, and delete retries. It does not
  replace a complete inspection/import/plan/status round trip for every adapter.
  The backlog's database-parity item has been corrected to reflect that existing
  shared coverage; its import-round-trip gap is still substantive.
- **Run isolated live contracts before promotion.** Use the existing normal
  spec/plan/apply harnesses and preserve failed resources for recovery. The basic
  runner still has an explicit TODO for complete provider project/environment
  teardown; workload/datastore cleanup is not proof that all hosting context is
  gone. Cost-bearing live tests and package publication were not performed.

## Existing-project upgrade sequence

1. Preserve the installation's database and private root key together, along
   with committed spec/binding history. Generated-secret recovery depends on
   retaining the original root key, not just the database export.
2. Update the project's pinned package/lockfile where applicable and the CLI/MCP
   runtime used to operate it. New desired-state fields must not be introduced
   ahead of the runtime that understands them.
3. Read the existing spec and scoped bindings in the correct checkout. Treat
   ambiguous legacy identities as an inspection/import decision, not absence.
   Missing runtime declarations require repository build evidence or an explicit
   runtime decision when generated builds are needed.
4. Generate a new plan with the updated runtime. Review adoption, secret
   replacement, workflow changes, and provider-source changes independently;
   do not reuse pre-upgrade plans.
5. Converge managed repository files through their infrastructure pull request,
   then complete the remaining plan/apply stage. Use managed CI trigger/status
   and health verification for releases; a successful configuration write alone
   does not prove the application is running the new configuration.

## Validation

Baseline: 1,891 tests passed across two targeted selections, plus TypeScript
typecheck. Post-change focused checks cover repository ownership, generated
secret export failure/retry, service action authority, active domain handling,
and simulated live cleanup. The broader offline suite passed **2,888 tests in
230 files**, excluding opt-in live tests. The subsequent newer-schema guard
passed its **9-test** state/security selection and typecheck. A separate
read-only probe parsed Hypervibe's own committed specs from all seven releases
`0.1.18`–`0.1.24` using the current schema. That is historical parser evidence,
not a complete customer-project upgrade lifecycle. `git diff --check` passed.

Final integrated branch: **2,970 offline tests passed across 231 files**,
including the corrected shared Railway parity fixture. Typecheck and diff
checks passed. The read-only Railway upstream check matched **69 schema
fields and five CLI behaviors** against official sources. No live provider
mutation or release was performed.
