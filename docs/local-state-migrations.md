# Local SQLite history reconciliation

Local SQLite migration versions are unrelated to PostgreSQL database schemas.
Invoice Perfect's `public` and `invoice_perfect_workflow` schemas are intentional
application namespaces. This reconciliation neither opens nor changes those
databases.

The assumption that matching migration numbers identify matching schema changes
was false. Read-only local metadata observed on 2026-10-25 recorded
`11:companion_read_model_v1` and `12:rotation_workflow_snapshots`, whereas the
current branch used `11:serialize_plan_applies`. Historical Git commits
`b4efbb9` and `77c39f6` define the rotation snapshot migration; `6f536cf` instead
defines `12:provider_login_sessions`. The observed local database lacked both
apply serialization indexes. This establishes divergent history, not an
interrupted migration or the cause of the Railway credential incident.

Migration 13, `reconcile_historical_apply_serialization`, preserves every existing
migration record, timestamp, table, trigger, and row. It installs the missing
unique indexes for one running apply per environment and one successful apply
per plan. Canonical migration 11 and the bridge use the same checked installer.
New databases receive canonical migrations 1–11 and 13; version 12 is reserved
for the two known historical identities and is never fabricated.

Before pending migrations execute, the runtime validates recorded identities.
Known historical identities require the complete common base history and exact
fingerprints of their additive SQL definitions, allowing whitespace formatting
differences. These fingerprints include all 30 observed companion tables,
indexes, and triggers. Objects without a matching historical marker, unknown
objects in those namespaces, changed definitions, unknown migration identities,
and future versions fail closed. Existing apply index names must also have the
required unique definitions; names alone prove nothing. After migration 13, a
missing apply index is an error, not silently accepted migration success.

The bridge checks conflicting run history before creating either index. If
conflicts exist, it rolls back without changing history or choosing which run
to discard. Historical features' data remains available to compatible readers;
this code does not reinstate their obsolete application workflows.

The schema-only evidence fixture is
`src/adapters/db/__tests__/fixtures/historical-migration-objects.json`. Companion
definitions are a recorded local `sqlite_master` observation, not a claim that
their original writer source was recovered. Rotation/login definitions were
executed from the named historical source commits in disposable SQLite before
recording SQLite's stored definitions. No customer rows, credential values, or
runtime identifiers were exported. Regression rows are synthetic.

`npm test -- src/adapters/db/__tests__/historical-migrations.test.ts` initially
failed all 12 cases with the existing runtime. During PR isolation against
`c72700b`, all 15 expanded historical regressions failed before the runtime
change and passed afterward. The five focused SQLite suites passed all 30
checks, covering history reconciliation, apply reservations, component encryption,
upgrades, and local database security. The historical suite exercises the actual
SQLite engine for preserved history/data, repeated opening, both alternative
historical version-12 identities, conflicting applies, misleading index names,
corrupt historical objects, and missing identities. The tests are discovered by
the normal `npm test` acceptance path. They establish compatibility with the
recorded definitions, not every unpublished historical branch.

On 2026-10-25, a separate one-off check opened the actual local database read-only
and used SQLite's online backup into a private disposable directory. The copy
migrated to 13, reopened without another migration, passed `integrity_check` and
had no foreign-key violations. In-memory comparisons established that all
existing migration records/timestamps, data-table row contents, and original
schema objects were unchanged. Repository reads decrypted the copied component
state with the retained key and parsed credential/rollout recovery state. The
key stayed in process memory; the copy was deleted. This check did not migrate
the live local database or contact a provider.

Before opening real local state with the updated runtime, create a consistent
SQLite backup, retain its encryption key, and verify the migration against a
private disposable copy. Never delete migration rows, lower version numbers,
rename old identities, or reset the database to get past the guard. Local
reconciliation and runtime activation do not authorize production database
rotation, deployment, or a client-process restart.

An older runtime that supports schema 11 will refuse state after the bridge is
recorded. Rollback requires a compatible runtime or a reviewed restore of the
pre-migration backup; removing the version-13 record is not a rollback.
