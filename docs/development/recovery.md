# Backup and recovery

Read before changing backup defaults, recovery points, restore evidence, retained data, or supported provider combinations.

These are normative maintainer rules, complementary to `ARCHITECTURE.md`,
which remains the infrastructure model's source of truth. Load only the sections
relevant to the task. Paths in code spans are relative to the repository root.

Related contracts: [Database Resilience](../../ARCHITECTURE.md#database-resilience), [backup defaults](../default-backup-policy.md), and the [shared recovery contract](../recovery-contract.md).

Rule IDs remain stable for references. These files are for developing Hypervibe;
the distributed user workflow lives in
[`skills/hypervibe`](../../skills/hypervibe/SKILL.md).

## DG-011

Backup coverage reports every persistent database, declared or retained service mount, and object bucket through the shared provider contract. Ordinary planning and deployment must not require backup setup, an archive bucket, a completed recovery point or a tested restore. Use explicit `hv_plan scope="backups"` with daily intent for separately reviewed backup work; only that scope may propose a derived archive, and provisioning still requires exact billable-action confirmation. Omitted backup intent means unmanaged, not that provider snapshots are disabled. Preserve stronger native schedules, retention and PITR; an explicit exclusion never disables or deletes existing provider protection. Keep policy configuration, an available recovery point and a tested restore separate, and report unsupported or unknown coverage instead of treating versioning, replication or an empty action list as a backup. Read-only coverage defaults do not rewrite legacy deployment hashes; an outstanding explicit checkpoint retains its isolated priority.

An environment may explicitly request cloud-managed PostgreSQL backups with
`database.automatedBackups: true`. A change to the database's backup switch
requires an infrastructure plan and exact action confirmation. Preserve the
provider's retention, recovery settings and shared-server ownership. At a
guided cutover, accepting these backups in place of the source's database-only
daily program requires fresh evidence for the destination database and a review
that explains the change in independent copies and restore tests. Keep cutover
blocked for any additional protected bucket, volume or retained database.

For new cloud document archives, use the environment's hosting provider. Plan a
separate Cloud Storage bucket on Google Cloud, an S3 bucket on AWS, or a Blob
Storage container on Azure. Show the destination and cost in the backup plan.
Retain the source archive through migration until the replacement covers the
required history and a restored database can resolve its file references.
This is the target for [cloud file recovery](https://github.com/davejohnson/hypervibe/issues/253).

## DG-076

Before replacing a release-evidence format, preserve a read-only way to inspect an existing recovery baseline. Keep original artifact/run/source provenance; never synthesize missing historical fingerprints from current desired state. Evidence compatibility, image availability, and a successful restore are separate claims.

## DG-106

Before a backup mutation, persist its exact scoped source and unique operation identity. An uncertain acknowledgement must never trigger an automatic second backup. Confirm completion through the provider's terminal operation and the matching backup inventory, keep provider snapshots distinct from tested restores, and never use a source-volume restore as a harmless verification step.

## DG-107

Recurring recovery programs require exact published source/destination identities and a pinned helper artifact. The managed workflow schedules one backup per day and verifies the restore during that backup. Expose the run outcome and operational receipt through GitHub Actions. Health checks between runs are on demand. The workflow must have no recurring health poll, GitHub issue alert or issue-write permission.

Keep schedule, retained-point and restore evidence separate. Backup setup and health are independent of ordinary rollout admission; report prerequisite-only backup applies as pending and skipped backup work as skipped, never complete. Ordinary repository publication preserves accepted backup programs and never creates, updates or retires them, even if a new program is ready. Explicit `scope="backups"` selects only the requested environment's program independently of the canonical repository environment; it must not publish unrelated repository policy or another environment's backup files. Validate that scope and exact file authority again when loading the persisted plan. Program retirement needs an explicitly disabled declaration and a separate backup-scoped review; it never deletes provider snapshots or retained recovery data. Re-observe native source identity in scheduled consumers as well as local planning. A selected resource ID does not attenuate a credential: require provider-proven credential scope before private-worker handoff. Write completion last, attest provider cleanup separately, and require complete sets for retention and recovery health. A database/files set must verify the restored database's references against retained file bytes; successful independent copies do not establish application consistency.

## DG-108

Bind prior restore proof to native revisions captured from checksum-verified retained bytes. Check those revisions during health and whenever fresh inventory becomes conditional-delete authority; matching names and lengths cannot detect same-size replacement. Version stronger evidence formats, retain historical contracts without certifying or deleting them, and never invent missing historical proof.

## DG-109

Admit provider combinations through shared capability metadata, not the independent existence of two adapters. Validate the current destination selection and helper artifact at execution time, and test the published helper's authentication contract through its real consumer. Missing cleanup proof and ambiguous mutation counts remain unknown, never implicit success or zero writes.

## DG-110

Define persisted safety evidence with one runtime schema and derive its type from that schema. Producers, completion coordinators and later health/retention readers must validate the same contract; selected-field checks can accept incomplete or contradictory proof. Exercise a real producer through those consumers and reject altered coverage or verification claims before granting readiness or deletion authority.

## Retained data and operational recovery

A checkpoint is a snapshot request, not a tested restore or independent copy.
Preserve its source, operation identity, acknowledgement and uncertain state
across export/import and retries. Railway snapshot restore replaces the source
volume and must never be used as harmless verification. The
[checkpoint contract](../database-checkpoints.md) and
[shared recovery contract](../recovery-contract.md) define supported evidence.

Data moves copy into fresh isolated targets and verify them before binding or
consumer cutover; rollback targets are retained until a separate confirmed
cleanup. A maintenance pause preserves exact restoration state and blocks
ordinary changes that could restart the source. Application-only pause does not
prove a database write fence, drained jobs or authority to copy data. Resuming
traffic restores workload settings, not writes made elsewhere. Preserve the
[maintenance and data-move boundaries](../data-migration.md), including explicit
unsupported capabilities and unknown cleanup outcomes.
