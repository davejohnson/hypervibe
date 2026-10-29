# Backup and recovery

Read before changing backup defaults, recovery points, restore evidence, retained data, or supported provider combinations.

These are normative maintainer rules, complementary to `ARCHITECTURE.md`,
which remains the infrastructure model's source of truth. Load only the sections
relevant to the task. Paths in code spans are relative to the repository root.

Related contracts: [Database Resilience](../ARCHITECTURE.md#database-resilience), [backup defaults](default-backup-policy.md), and the [shared recovery contract](recovery-contract.md).

Stable rule IDs preserve the original guidance and are mapped in
[the migration audit](development-guidance-migration.json). These files are
for developing Hypervibe; the distributed user workflow lives in
[`skills/hypervibe`](../skills/hypervibe/SKILL.md).

## DG-011

Backup coverage reports every persistent database, declared or retained service mount, and object bucket through the shared provider contract. Ordinary planning and deployment must not require backup setup, an archive bucket, a completed recovery point or a tested restore. Use explicit `hv_plan scope="backups"` with daily intent for separately reviewed backup work; only that scope may propose a derived archive, and provisioning still requires exact billable-action confirmation. Omitted backup intent means unmanaged, not that provider snapshots are disabled. Preserve stronger native schedules, retention and PITR; an explicit exclusion never disables or deletes existing provider protection. Keep policy configuration, an available recovery point and a tested restore separate, and report unsupported or unknown coverage instead of treating versioning, replication or an empty action list as a backup. Read-only coverage defaults do not rewrite legacy deployment hashes; an outstanding explicit checkpoint retains its isolated priority.

## DG-076

Before replacing a release-evidence format, preserve a read-only way to inspect an existing recovery baseline. Keep original artifact/run/source provenance; never synthesize missing historical fingerprints from current desired state. Evidence compatibility, image availability, and a successful restore are separate claims.

## DG-106

Before a backup mutation, persist its exact scoped source and unique operation identity. An uncertain acknowledgement must never trigger an automatic second backup. Confirm completion through the provider's terminal operation and the matching backup inventory, keep provider snapshots distinct from tested restores, and never use a source-volume restore as a harmless verification step.

## DG-107

Recurring recovery programs require exact published source/destination identities and a pinned helper artifact. Keep schedule, retained-point and restore evidence separate. Backup setup and health are independent of ordinary rollout admission; report prerequisite-only backup applies as pending and skipped backup work as skipped, never complete. Ordinary repository publication preserves accepted backup programs and never creates, updates or retires them, even if a new program is ready. Explicit `scope="backups"` selects only the requested environment's program independently of the canonical repository environment; it must not publish unrelated repository policy or another environment's backup files. Validate that scope and exact file authority again when loading the persisted plan. Program retirement needs an explicitly disabled declaration and a separate backup-scoped review; it never deletes provider snapshots or retained recovery data. Re-observe native source identity in scheduled consumers as well as local planning. A selected resource ID does not attenuate a credential: require provider-proven credential scope before private-worker handoff. Write completion last, attest provider cleanup separately, and never count partial sets toward retention or healthy alerts. A database/files set must verify the restored database's references against retained file bytes; successful independent copies do not establish application consistency.

## DG-108

Bind prior restore proof to native revisions captured from checksum-verified retained bytes. Check those revisions during health and whenever fresh inventory becomes conditional-delete authority; matching names and lengths cannot detect same-size replacement. Version stronger evidence formats, retain historical contracts without certifying or deleting them, and never invent missing historical proof.

## DG-109

Admit provider combinations through shared capability metadata, not the independent existence of two adapters. Validate the current destination selection and helper artifact at execution time, and test the published helper's authentication contract through its real consumer. Missing cleanup proof and ambiguous mutation counts remain unknown, never implicit success or zero writes.

## DG-110

Define persisted safety evidence with one runtime schema and derive its type from that schema. Producers, completion coordinators and later health/retention readers must validate the same contract; selected-field checks can accept incomplete or contradictory proof. Exercise a real producer through those consumers and reject altered coverage or verification claims before granting readiness or deletion authority.
