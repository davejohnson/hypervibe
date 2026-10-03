# Daily backup defaults

Hypervibe's default is daily backup protection for an environment's databases,
persistent service volumes and object buckets. This is desired state, not a
claim that every provider adapter has implemented it or that a backup has run.
Plan and status report coverage for each resource, including explicit gaps.

An environment may state the default explicitly:

```json
{
  "backups": { "mode": "daily" }
}
```

Omitting `backups` has the same policy meaning. The default is resolved at the
backup boundary; it does not insert fields into older specs or change their
existing deployment-contract hashes merely by being read.

A disposable environment may opt out with a reason:

```json
{
  "backups": {
    "mode": "disabled",
    "reason": "Disposable preview data can be recreated from fixtures."
  }
}
```

This excludes the environment from Hypervibe's daily-policy enforcement. It
does not disable a provider's existing backups, delete recovery points, remove
PITR, or shorten retention. The exclusion remains visible in coverage output.

## What the default does

The shared policy follows the existing `hv_spec` → `hv_plan` → `hv_apply` →
`hv_status` lifecycle. It covers declared resources and retained database,
mount and object-bucket bindings. Previous or unresolved targets remain visible
as unknown coverage until their exact sources are reconciled. A provider
capability must establish the exact source identity and observe its current policy before a policy change
can be planned. Unknown observation is a gap, never proof that protection is
absent or that it is already sufficient.

A new resource first receives a durable binding in an isolated provisioning
plan. Subsequent plans configure protection, publish the reviewed backup program,
and require the first completed recovery set before ordinary deployment. The
tool reports these prerequisite stages as pending. An unsupported source,
unknown read, missing point or expired restore proof blocks rollout; it is not
silently waived by a service-only plan or a previously applied spec hash.

Accepted deployment workflows can still need credential or binding
synchronization. That downstream work must not prevent an independent backup
archive from receiving its reviewed storage binding. Archive provisioning keeps
its real namespace dependencies and does not synchronize CI credentials, wire
application services or authorize a rollout in the same stage.

A recovery-readiness blocker is a prerequisite failure. Tool output preserves
the protection gaps and directs the operator to resolve them before re-planning;
it does not request a new provider credential unless a separate connection
failure was observed.

Supported adapters add daily protection while preserving existing weekly or
monthly schedules, longer retention and PITR. Native retention is reported as
observed; the default does not promise the same retention window on every
provider. Existing stronger protection must not be replaced by a smaller
Hypervibe default. Policy operations do not restore data, change the source
image, redeploy workloads, or create a one-time checkpoint.

Policy changes are separate reviewed, billable actions with exact confirmation.
A durable reservation records each attempted write before contacting the
provider. An uncertain result permits observation and reconciliation, but never
an automatic repeat of that write. Recovery also compares a provider-owned hash
of the native schedules and settings that must survive the change. Observing
daily scheduling alone cannot clear an attempt if previous protection changed.
Hash mismatches remain a coverage gap for review, even when an external change
may have strengthened protection.

An outstanding named database checkpoint keeps its existing isolated priority.
Daily-policy work cannot bypass that checkpoint or be bundled into its apply.
The checkpoint and recurring policy answer different questions: a backup for
this change versus protection that continues tomorrow.

Temporary container filesystems and request scratch directories are not
persistent volumes. They are not covered by a mount backup. Application-owned
files awaiting user review may still need preservation: the application must
place those bytes in durable storage or account for them in its recovery plan.
Hypervibe cannot infer that a directory called `tmp` is disposable.

## What a status means

Keep these facts separate in receipts and operator guidance:

| Fact | Required evidence |
| --- | --- |
| Daily policy configured | Fresh native policy observation, or the exact published and active managed backup workflow, for the bound sources and destination. |
| Recovery point available | A completed, usable point on that resource, with its identity and retention checked. |
| Restore tested | An isolated restore and its declared data/application checks actually succeeded. |

Native policy adapters establish the first fact only. The managed recovery-set
runtime below supplies separate completed-point and restore evidence. Status
reports policy, available recovery points and restores independently. Unsupported
adapters, missing prerequisites and unknown reads remain explicit gaps.

Independent daily database and file backups are resource-level protection.
They do not establish an atomic application recovery point. An application
whose database refers to files needs a compatible database/file recovery set,
with coordinated writes or another verified consistency mechanism where needed.
See the [shared recovery contract](recovery-contract.md) for the separate
verification checks and the distinction between code rollback and data restore.

## Managed retained recovery sets

The baseline is daily execution, retaining seven completed sets as history
builds, and restore evidence no older than seven days. The first verified set
can satisfy backup readiness; seven prior runs are not an activation prerequisite.
Retention removes older sets only after preserving seven complete sets and the
latest tested restore. The initial implementation performs
the isolated restore during every successful backup, which is stronger than
the weekly minimum. It uses a published, immutable Hypervibe helper image;
no application deployment or public database URL is required by the admitted
Railway private-task path.

When application object storage already declares a provider and region, the
effective plan derives a separate `hypervibe-backups` bucket in that placement.
It is a normal reviewed, billable storage action with no application credential
injection. Existing names are never repurposed. Projects without an established
storage placement declare a separate bucket with `purpose: "backup"` and name
it in `backups.destination`. Multiple possible destinations require an explicit
selection. Removing the policy retains its backup bucket and historical sets.

Activation requires `backups.mode: "daily"`, `backups.runnerImage` set to the
actual published helper digest, and complete source/destination bindings. A
combined database/files set also declares one `fileReferenceQueries` entry per
application bucket, each returning one text column named `key` from the restored
database. A digest placeholder is not runnable infrastructure. The reviewed
backup workflow and exported database identities must be committed before its
controller accepts a run.

Database bindings must include valid durable `providerScope` coordinates. A
legacy binding with wholly absent scope may receive a separate, confirmed
`database-bindings` plan. Its native backup observer must independently prove
the exact bound database and all scope coordinates, which must agree with the
existing legacy bindings. Apply rechecks that evidence and saves only the missing
scope; it does not change provider resources, desired state, credentials or
checkpoint history. Re-plan after this prerequisite. Conflicting, incomplete or
unobservable identities remain blocked; see the
[provider review](recovery-contract.md#legacy-database-scope-reconciliation).
Hypervibe never substitutes an assumed hosting placement for database evidence.

The managed program currently covers at most one bound PostgreSQL database and
declared application buckets. Retained databases or buckets outside that target
remain visible coverage gaps; they do not inherit the current target's healthy
receipt. This program does not implement restore verification for those retained
sources, so they keep readiness blocked.

For initial setup, follow the plan's stages in order:

1. Declare the published helper digest, backup destination where needed and any
   database file-reference queries through `hv_spec`. Run `hv_plan`, review and
   confirm its prerequisite actions, then apply them with `hv_apply`. Re-plan
   after each prerequisite stage so resource bindings and native policies can
   be observed before dependent work.
2. When the plan reports `backup-program-publication`, confirm and apply its
   repository action to open the reviewed infrastructure pull request. This
   stage publishes the program for review; it does not merge, dispatch a backup
   or deploy the application. Review and merge the program, current spec and
   latest `.hypervibe/bindings.json` export into the repository's default branch.
3. Use `hv_ci_status` to discover the published
   `.github/workflows/hypervibe-backup-<environment>.yml` definition. Dispatch that
   exact definition on the default branch with `hv_ci_trigger` and
   `inputs: { "operation": "backup" }`, then inspect the run with `hv_ci_status`.
   An uncertain backup execution is inspected with `operation: "health"`;
   rerunning its backup attempt is rejected.
4. After a completed recovery set and cleanup are verified, run `hv_plan` again.
   The `backup-readiness` stage blocks ordinary deployment while point or restore
   evidence is missing, stale or unknown. A prerequisite-only apply is still
   pending deployment; it is not an application release.

The runtime holds a read-only SQL snapshot, archives it, reads the stored bytes
back and restores them into an owned local PostgreSQL instance. Object streams
use native revision conditions, retained per-run keys and SHA256 read-back.
Files are restored into a fresh temporary location and independently checked.
Every database-referenced key must be present in the matching file manifest.
A combined completion marker is written last; a second controller marker records
successful completion and verified cleanup of the private task or controller-local
run. Partial sets cannot count toward health or retention. Retention deletes only conditionally matched,
manifest-owned keys after preserving seven complete sets and the latest tested
restore. It never propagates source deletions into retained history.
SQL archives and copied files record the native revisions observed during their
checksum-verified read-back. Health and retention compare those revisions with
current inventory, including the final inventory used for conditional deletion.
A same-size replacement with a changed native revision invalidates the prior restore proof. This remains a
native-validator check, not a continuous byte audit. Provider soft delete or
version history may retain older billable bytes after a current key is removed;
this policy does not purge that history.

SQL, object and joint completion manifests now use evidence format 2. Existing
format-1 proof cannot certify the current program because it lacks retained
revision evidence. Historical target contracts remain readable as stored JSON
and are left untouched; they neither certify nor block a newly completed current
contract. A new helper digest requires a reviewed program update and a fresh
successful backup. Missing historical proof is never synthesized.

This establishes referential compatibility, not a global transaction across
arbitrarily mutable files and SQL. Applications that overwrite keys in place
need a stronger version/snapshot contract before calling that combination
consistent. Database coverage excludes cluster roles, grants, server settings
and the running application artifact; see the
[logical backup runtime](postgres-logical-backup-runtime.md).

The reviewed GitHub workflow runs daily and observes health hourly. It shares
the deployment concurrency group. Unknown, missing, stale or failed evidence
creates or updates a scoped GitHub issue; only a valid healthy receipt closes
that bot-owned alert. Observation checks exact inventory and prior restore
evidence; it does not download and rehash every byte hourly. A stopped scheduler
cannot alert about itself, so an independent monitor remains a separate concern.

Generated GitHub deployment checks use fresh backup health before migrations or
rollout. GitLab daily recovery execution is not implemented and therefore blocks
ordinary deployment for a required daily policy. Verified immutable code rollback
keeps its existing separate evidence path.

The helper image must be built and published before setup. Merging the managed
workflow enables its schedule; a successful first provider execution is required
before claiming operational backup protection. No live deployment, backup completion or restore is certified
by these source changes. The private database runner is currently admitted only
for Railway hosting with a Railway database. Combined SQL/files jobs also require provider-proven, bucket-scoped
worker credentials. That handoff is implemented for Railway buckets; S3, GCS
and Azure remain blocked for combined jobs. Object-only jobs use their stream
adapters in the controller without handing control-plane credentials to a worker.

## Provider review and implementation coverage

Reviewed against the named registry providers and official sources on
2026-09-30. Native product capability, Hypervibe adapter implementation and live
verification are separate evidence. A row marked unsupported below means
unsupported by this Hypervibe capability unless it explicitly identifies a
native product limitation. No row certifies a live backup or restore.

### Databases

| Database provider | Native evidence and limits | Hypervibe daily-policy coverage |
| --- | --- | --- |
| Railway | [Daily volume schedules](https://docs.railway.com/volumes/backups) coexist with weekly/monthly schedules and have a native six-day retention window. PITR is separate. | Observe the exact database volume instance; add daily while preserving other schedules. Missing observed retention remains unknown. |
| Cloud SQL | [Standard daily backups](https://docs.cloud.google.com/sql/docs/postgres/backup-recovery/backups) have count-based retention; [Enhanced Backup and DR](https://docs.cloud.google.com/sql/docs/postgres/backup-recovery/backup-options) is a separate control plane. | Standard daily policy observation and additive enablement. Preserve existing retention, windows and PITR. Legacy explicit backup/PITR policy keeps its meaning. |
| RDS | [Automated daily backups](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_WorkingWithAutomatedBackups.BackupRetention.html) retain one to 35 days when enabled. Moving retention between zero and nonzero can interrupt service. | Unsupported by this adapter capability; no implicit retention change. |
| Supabase | [Eligible paid projects](https://supabase.com/docs/guides/platform/backups) receive daily backups while PITR is disabled. Enabling PITR stops daily backups. Database backups exclude Storage objects. | Unsupported by this adapter capability; no plan upgrade or PITR change. |
| Azure PostgreSQL | [Flexible Server backups](https://learn.microsoft.com/en-us/azure/postgresql/backup-restore/concepts-backup-restore) have daily cadence and configurable retention. New snapshots can pause while data is unchanged. | Unsupported by this adapter capability. Snapshot age alone cannot prove a missed backup for an idle database. |
| Neon | Paid plans offer [scheduled branch snapshots](https://api-docs.neon.tech/reference/setsnapshotschedule), observed through the [schedule API](https://api-docs.neon.tech/reference/getsnapshotschedule). These are distinct from PITR history; exact schedule retention was not established in this review. | Unsupported by this adapter capability; no paid-plan assumption. |
| Fly Managed Postgres | Official staff described [daily full backups](https://community.fly.io/t/scheduled-backups-in-managed-postgres/25132); the current API lists [cluster backups](https://docs.fly.io/api/machines/postgres-clusters/list-backups). Exact current retention remains unverified. These are separate from Fly Volume snapshots. | Unsupported by this adapter capability; no volume-retention assumption. |
| DigitalOcean Managed PostgreSQL | [Daily backups](https://docs.digitalocean.com/products/databases/postgresql/how-to/restore-from-backups/) retain seven days; deleting the cluster deletes its backups. | Unsupported by this adapter capability; native automatic policy is not observed Hypervibe coverage. |

Daily intent does not automatically enable PITR, HA or a paid
provider tier. Some native products combine daily snapshots with continuous
history; adapters must preserve those semantics instead of treating them as
interchangeable or disabling stronger protection to match a label.

### Persistent service mounts

| Hosting provider and backing store | Native evidence and limits | Hypervibe daily-policy coverage |
| --- | --- | --- |
| Railway volume | [Native schedules](https://docs.railway.com/volumes/backups) include daily backups retained six days. Wiping the volume also removes its backups; this is not an independent off-provider copy. | Daily schedule observation and additive configuration for the exact bound volume. |
| Fly Volume | [Automatic daily snapshots](https://docs.fly.io/volumes/snapshots/) default to five-day retention, configurable from one to sixty days. | Unsupported by this adapter capability. Native defaults are not verified Hypervibe coverage. |
| ECS Express / regional EFS | [AWS Backup](https://docs.aws.amazon.com/efs/latest/ug/awsbackup.html) offers daily automatic backups with a default 35-day window. API-created regional EFS does not enable these automatically; Hypervibe creates that class through the API. | Unsupported by this adapter capability. |
| Cloud Run / BASIC_HDD Filestore | [Standard backups](https://docs.cloud.google.com/filestore/docs/backups) support this tier; native enhanced scheduling excludes Basic. Google documents [scheduler/function automation](https://docs.cloud.google.com/filestore/docs/schedule-backups-cloud-scheduler). | Unsupported by this adapter capability; no automatic tier upgrade or scheduler creation. |
| Azure Container Apps / SMB Azure Files | [Azure Backup](https://learn.microsoft.com/en-us/azure/backup/quick-backup-azure-files-vault-tier-portal) supports daily schedules. Snapshot tier stays with the source; vaulted backup copies data to a vault. [Region/protocol limits](https://learn.microsoft.com/en-us/azure/backup/azure-file-share-support-matrix) apply. | Unsupported by this adapter capability. |
| DigitalOcean App Platform | [Persistent mounts are not supported by App Platform](https://docs.digitalocean.com/products/app-platform/how-to/store-data/). Local files are ephemeral. | No mount target; requested persistent volumes remain unsupported. External databases/buckets have their own coverage. |
| Vercel Functions | [Functions lack a persistent writable filesystem](https://vercel.com/kb/guide/why-does-my-serverless-function-work-locally-but-not-when-deployed). | No mount target; requested persistent volumes remain unsupported. External databases/buckets have their own coverage. |

### Object storage

Object versioning, soft delete and replication are useful protections, but they
are not proof of an independent retained backup. A mirror that overwrites its
only copy or propagates deletion also does not preserve daily recovery history.

| Provider | Native evidence and candidate mechanism | Hypervibe daily-policy coverage |
| --- | --- | --- |
| Railway buckets | [S3-compatible operations](https://docs.railway.com/storage-buckets) support copying objects; versioning, object locks and lifecycle configuration are unavailable. A separate retained-copy destination is needed. | Managed retained-copy stream and private SQL/files handoff implemented; live acceptance remains required. |
| Amazon S3 | [AWS Backup](https://docs.aws.amazon.com/aws-backup/latest/devguide/s3-backups.html) supports daily periodic recovery points in a vault. Source versioning is a prerequisite, not the separate backup itself. | Managed retained-copy stream implemented. A scoped private SQL/files credential handoff and native AWS Backup vault management remain unimplemented. |
| Google Cloud Storage | [Storage Transfer Service](https://docs.cloud.google.com/storage-transfer/docs/create-transfers) can schedule daily copies. A retained destination/history policy is still required; [source versioning and redundancy](https://docs.cloud.google.com/storage/docs/protection-backup-recovery-overview) are different protections. | Managed native stream preserves generations and raw gzip bytes. Object-only runner supported by the shared contract; private SQL/files handoff remains blocked. |
| Azure Blob Storage | [Vaulted backup](https://learn.microsoft.com/en-us/azure/backup/blob-backup-configure-manage) supports daily schedules. [Operational backup](https://learn.microsoft.com/en-us/azure/backup/blob-backup-overview) keeps protection in the source account rather than copying data to a vault. | Managed native conditional object stream implemented; private SQL/files handoff remains blocked. Native vaulted-policy management is separate. |

The retained-copy implementation extends existing provider-neutral object
streams with revision conditions and byte verification. The older migration
transfer helper retains its own contract.
Do not invoke `dataMigration` as a backup shortcut: it changes active storage
bindings after a successful copy.

## Evidence still needed for complete recovery

Mounted filesystems still need provider-specific export or isolated snapshot
restore support before a tested recovery set can include them. A configured
Railway volume schedule alone cannot pass the restore-readiness gate. Durable
files in undeclared mounts or ephemeral application paths require an application
storage audit; they cannot be discovered from the desired spec alone.

A bucket on the same service/account is not an independent disaster copy.
That follow-up is tracked for HLS in
[issue #655](https://github.com/davejohnson/hls-property-care/issues/655).
Application health, migration compatibility, independent monitoring of the
scheduler and live provider acceptance remain separate evidence.

Normal contract checks must cover every named database, hosting and object
provider, including unsupported rows; implicit defaults and explicit exclusion;
retained mounts; unknown observations; stronger-policy preservation; isolated
checkpoint priority; and unchanged legacy deployment hashes. Provider API
fixtures validate the documented transport boundary. Passing them does not
establish a live daily backup or a working restore.
