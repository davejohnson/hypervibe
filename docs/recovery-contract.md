# Shared recovery contract

Recovery uses the existing spec/plan/apply lifecycle and managed deployment
evidence. The shared contract describes exact source identity, a recovery point,
durable operation state, and separate verification boundaries. Provider adapters
own their native identifiers, polling, correlation and restore implementation.
This identity and evidence contract does not itself authorize a restore or
provider mutation. The existing native checkpoint/drill capabilities and the
separate [managed retained-set runtime](default-backup-policy.md#managed-retained-recovery-sets)
perform only their reviewed lifecycle operations.

[Daily backup defaults](default-backup-policy.md) describe recurring protection
for databases, persistent mounts and object storage through this same lifecycle.
An observed daily policy does not establish an available recovery point or a
tested restore. Named checkpoints retain their isolated execution priority;
recurring policy work does not enlarge checkpoint mutation authority.

## Identity, points and operations

`RecoverySourceIdentity` includes the provider, exact primary resource ID,
provider scope and additional resource identity. All coordinates are explicitly
allowlisted identity fields; arbitrary metadata and credential fields are
rejected, along with URL-like values and control characters. Provider resolvers
validate that required coordinates are native non-secret identifiers; a generic
schema cannot identify every secret disguised as an ID. Equality includes the provider and every coordinate,
so equal-looking IDs in different projects, accounts or instances are different
sources. Adding a coordinate requires reviewing its export safety.

`RecoveryPoint` distinguishes a named snapshot from a timestamp/LSN in retained
history. A point describes what was selected; it does not prove availability.
Snapshot creation time is not automatically the time represented by its data.
Timestamp/LSN selection has no fabricated snapshot or workflow ID. Provider
adapters must check the source's actual retention window and eligibility.

The checkpoint capability creates named snapshots only. Before creation it
persists the exact source, unique request label, request time and prior inventory.
An acknowledged request can carry an opaque operation ID, but the shared contract
does not require a Railway workflow. The adapter observes the retained request
and reports pending, failed, unknown or complete with its exact correlated point.
Unknown acknowledgement or observation never permits a second creation. Shared
orchestration rechecks source identity and point availability before completion.
Railway still requires both terminal workflow success and the matching inventory.

Existing Railway records remain readable through an exact legacy decoder. They
are identified as Railway from that old schema, never from the current desired
provider. Operation identities and uncertain reservations survive normalization,
repository export/import and resume. Conflicting records block recovery.

Restore-drill compilation uses a provider-owned source resolver over the bound
environment and database component. The shared compiler verifies ownership and
the safe identity before passing it to the provider compiler. Cloud SQL alone
parses its `project:region:instance` connection name. Its emitted drill continues
to restore a separate instance, run the existing SQL check and perform cleanup.

## Legacy database scope reconciliation

An existing database whose `providerScope` is wholly absent may receive one
confirmed `database-bindings` action. The shared planner uses the native
`dailyBackups.observe` source, before any managed-program projection. Every
scope coordinate must agree with the legacy component or its same-provider
environment binding. Missing, malformed or conflicting evidence is not authority
to infer placement, adopt another database or overwrite existing scope.

The action pins the exact component, provider, engine, external ID, complete
recovery source and a credential-free binding fingerprint. Apply rechecks the
current binding and freshly observed source before merging only `providerScope`.
It preserves the spec, services, credentials, checkpoint history and deployment
markers, and reports applied/skipped counts with zero provider mutations. Re-plan
after applying the prerequisite; it does not enable a schedule or verify a
restore. An outstanding checkpoint retains priority.

The following review, dated 2026-10-02, covers all eight registered database
providers. Eligibility is adapter behavior checked against these native identity
contracts, not a claim of live compatibility.

| Provider | Native identity evidence | Missing-scope repair |
| --- | --- | --- |
| Railway | [Pinned official SDL, CLI `f60f3a77`](https://raw.githubusercontent.com/railwayapp/cli/f60f3a77b980c47f1136909fbd9a443e29a2b95f/src/gql/schema.json): project-owned service/environment, environment-specific service instance and volume instance. | Eligible only with a matching legacy component project anchor and independently verified exact source, including one active volume. Missing both scope and anchor remains unknown. Ordinary database observation preserves the same complete scope, including custom-image fallback. |
| Cloud SQL | [Instance GET](https://docs.cloud.google.com/sql/docs/postgres/admin-api/rest/v1beta4/instances/get) selects project and instance; its response identifies project and region. | Blocked: the existing native daily observer requires durable project scope before reading. |
| RDS | [Instance identity](https://docs.aws.amazon.com/AmazonRDS/latest/APIReference/API_DBInstance.html) includes ARN and immutable regional `DbiResourceId`. | Unsupported: no native daily observation port. |
| Supabase | [Pinned official OpenAPI, `26585dd4`](https://raw.githubusercontent.com/supabase/supabase/26585dd4a4d6db8910a595214c9f6e8fdd206768/apps/docs/spec/api_v1_openapi.json): project reference, organization and region. | Unsupported: no native daily observation port. |
| Azure PostgreSQL | [Server GET](https://learn.microsoft.com/en-us/rest/api/postgresql/servers/get?view=rest-postgresql-2024-08-01): ARM server ID includes subscription and resource group. | Unsupported: no native daily observation port. |
| Neon | [Official OpenAPI](https://neon.com/api_spec/release/v2.json), checked-in source hash `731af8e540fc474a7f3da5fe1420d23da8248960ef11fff713f4b741c6471d24`: project, region and separate ownership/branch identities. | Unsupported: no native daily observation port. |
| Fly | [Managed Postgres](https://fly.io/docs/flyctl/mpg/): managed cluster and organization, distinct from app volumes. | Unsupported: no native daily observation port. |
| DigitalOcean | [Cluster schema](https://raw.githubusercontent.com/digitalocean/openapi/main/specification/resources/databases/models/database_cluster.yml): cluster UUID and region. [Account schema](https://raw.githubusercontent.com/digitalocean/openapi/main/specification/resources/account/models/account.yml) distinguishes user UUID from team UUID. | Unsupported: no native daily observation port; the existing account projection is not certified team-ownership evidence. |

Normal acceptance includes real SQLite plan/apply tests and Railway's actual
serialized GraphQL client against the pinned official schema. Fixture state is
synthetic. These tests establish preservation, identity rejection and query-only
provider access; they do not perform a live repair, backup or restore.

## Verification means separate evidence

Checkpoint receipts and rollback previews use the same versioned `recovery`
assessment. Each check is `verified`, `unknown`, `failed` or `unsupported`;
missing evidence is unknown. The checks are:

| Check | Evidence required to call it verified |
| --- | --- |
| `recoveryPoint` | Exact source and point remain observable, usable and within retention; required native completion is terminal. |
| `restoreTargetIsolation` | Restoration targets a separate exact resource and leaves the source unchanged. |
| `restoreSideEffectIsolation` | Restored background jobs, triggers and outbound integrations cannot affect live systems. A new resource ID is insufficient. |
| `databaseValidation` | The declared data/schema checks actually pass against the restored database. |
| `applicationArtifact` | Original release provenance and immutable artifact identity satisfy the existing release validator. |
| `applicationAvailability` | The artifact remains available through the provider's exact restoration path, including registry pull authorization where applicable; exact targets/runtime configuration have been verified. |
| `applicationHealth` | The restored application passes its health checks with the intended data and configuration. |
| `migrationCompatibility` | The candidate schema/migrations are compatible with the selected recovery release, based on explicit validation. |
| `cleanup` | Temporary drill resources are verified removed; no cleanup outcome is assumed from an accepted request. |

`ready` is true only when every check is verified. This report is evidence
presentation, never mutation authorization. Existing confirmation, exact-resource
authority, deployment locks and release validators remain authoritative.
Neither a provider capability flag nor an unchanged migration command verifies
any of these boundaries. A compiled drill is not an executed drill. The current
Cloud SQL drill does not establish every check in this complete assessment.

A checkpoint receipt can verify `recoveryPoint` while all restore/application
checks remain unknown. A compatible rollback preview can verify
`applicationArtifact` while registry availability, restoration, database recovery
and migration compatibility remain unknown. Legacy release blockers remain in
place. Code rollback does not reverse database migrations or restore data.

## Named provider review

Reviewed against the registry and official sources on 2026-09-30. These are
contract constraints and implementation coverage, not live certifications.
Normal acceptance tests enumerate all eight database providers and all seven
hosting providers; adding a provider requires updating that explicit review.

| Database provider | Native model checked | Current Hypervibe recovery implementation |
| --- | --- | --- |
| Railway | [Volume backups](https://docs.railway.com/volumes/backups): native restore replaces the original service's volume within its project/environment. Volume deletion removes its backups. | Named native checkpoint; no isolated native-volume restore adapter. The separate [logical retained-set runtime](postgres-logical-backup-runtime.md) restores copied SQL bytes into a fresh local PostgreSQL instance. |
| Cloud SQL | [BackupRun API](https://docs.cloud.google.com/sql/docs/postgres/admin-api/rest/v1beta4/backupRuns): IDs are scoped to an instance and native statuses distinguish successful, pending and failed backups. [Recovery](https://docs.cloud.google.com/sql/docs/postgres/backup-recovery/restore): PITR creates another instance. | Backup/PITR policy and scheduled PITR drill; no named checkpoint adapter. |
| RDS | [Snapshot restore](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_RestoreFromSnapshot.html) creates a new instance. Snapshot identity is not a volume-instance identity; an available instance can still be loading data. | Checkpoint and drill unsupported by Hypervibe. |
| Supabase | [New-project restore](https://supabase.com/docs/guides/platform/clone-project) is a database-only copy, requires eligible backups/plan, and can immediately execute copied jobs and external extensions. | Checkpoint and drill unsupported by Hypervibe. |
| Azure PostgreSQL | [Backup/restore](https://learn.microsoft.com/en-us/azure/postgresql/backup-restore/concepts-backup-restore): PITR creates a server; on-demand backup eligibility depends on tier/storage. [Restore configuration](https://learn.microsoft.com/en-us/azure/postgresql/backup-restore/how-to-restore-full-backup) requires its own checks. | Checkpoint and drill unsupported by Hypervibe. |
| Neon | [Branch creation](https://api-docs.neon.tech/reference/createprojectbranch) can select a parent timestamp or LSN. A branch can exist without a compute endpoint; [existing-branch restore](https://api-docs.neon.tech/reference/restoreprojectbranch) has different mutation semantics. | Checkpoint and drill unsupported by Hypervibe. |
| Fly Managed Postgres | [Managed Postgres](https://fly.io/docs/flyctl/mpg/) uses cluster/backup identity, separate from unmanaged app volumes. [Backup restoration](https://community.fly.io/t/managed-postgres-backup-restore-via-flyctl/26297) creates another billed cluster; [PITR](https://community.fly.io/t/fly-mpg-restore-now-supports-naming-and-point-in-time-restore/28464) has source-version prerequisites. | Checkpoint and drill unsupported by Hypervibe. |
| DigitalOcean | [Recovery](https://docs.digitalocean.com/products/databases/postgresql/how-to/restore-from-backups/) creates another cluster from retained history. Deleting the original cluster removes backups; retention and quota matter. | Checkpoint and drill unsupported by Hypervibe. |

Managed immutable-image rollback recipes exist for Railway, Cloud Run, ECS
Express, Azure Container Apps and Fly. DigitalOcean and Vercel do not expose that
capability in Hypervibe. The coverage test invokes all seven provider recipes;
it does not claim that a generated recipe has been exercised live. Direct-provider
deployment history still lacks the required immutable recovery evidence and is
not accepted as rollback authority.

| Hosting provider | Official recovery semantics checked |
| --- | --- |
| Railway | [Deployment actions](https://docs.railway.com/deployments/deployment-actions) depend on retention of the selected deployment image. Historical deployment identity does not prove current availability. |
| Cloud Run | [Revisions](https://docs.cloud.google.com/run/docs/managing/revisions) are immutable but can be removed. The [revision API](https://docs.cloud.google.com/run/docs/reference/rest/v1/namespaces.revisions) distinguishes resolved image digest from readiness. |
| ECS Express | [Service updates](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/express-service-update-full.html) use image identity plus health/traffic checks; [service revisions](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/service-revision.html) identify immutable configurations. |
| Azure Container Apps | [Revisions](https://learn.microsoft.com/en-us/azure/container-apps/revisions) do not version application-scoped secrets, ingress and registry credentials. Restoring an old revision does not restore all configuration. |
| Fly | [Machine identity](https://docs.fly.io/machines/api/machines-resource/) distinguishes resource, running version and image digest. [Rollback](https://docs.fly.io/blueprints/rollback-guide/) uses current configuration and does not undo migrations. |
| DigitalOcean App Platform | [Native rollback](https://docs.digitalocean.com/products/app-platform/how-to/manage-deployments/) selects an app/deployment and checks resource/configuration eligibility; database contents are separate. This is not implemented as Hypervibe immutable rollback. |
| Vercel | [Instant rollback](https://vercel.com/docs/instant-rollback) reassigns traffic to an existing deployment; no OCI image pull is required. [Webhook acknowledgement](https://vercel.com/docs/webhooks/webhooks-api) does not prove the traffic transition is complete. Hypervibe rollback remains unsupported. |

## Acceptance and remaining work

The ordinary `npm test` path checks registry completeness, provider capability
truth, safe source identity across all eight database models, unsupported
checkpoint planning, and the existing real Railway transport/lifecycle and
Cloud SQL workflow paths. An RDS-shaped compiler/operation fixture tests the
shared boundary without enabling an RDS adapter. Timestamp/LSN tests establish
representation, not implemented Neon recovery. Provider documentation is cited
evidence; only the existing pinned API fixtures claim schema validation.

This change fixes the shared contract and its existing consumers. It does not
add recovery mutations to the six remaining database adapters, perform a live
restore, prove application/schema compatibility, or make the HLS August release
executable through the current rollback consumer. Those require separately
reviewed adapter implementations and live evidence through this same contract.
