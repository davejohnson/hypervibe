# Recovering incomplete database creation

The shared contract separates an accepted, running native operation from a
failed operation. A local observation deadline does not change provider state.
Private generated database credentials stay in encrypted component bindings;
operation IDs and native scope remain available for verification. An incomplete
component never supplies credentials to an application or permits another create.

The October 31 disposable Cloud SQL run falsified the ten-minute completion
assumption. Hypervibe timed out while Google still reported `PENDING_CREATE` and
the original `CREATE` operation `RUNNING`, without an error. The old path retained
the instance name and scope but discarded its generated password. Google's
[operation contract](https://docs.cloud.google.com/sql/docs/postgres/admin-api/rest/v1/operations)
defines completion independently of a caller's wait budget. Two reconstructed
native-transport regressions failed before correction: pending state/private
credential retention, and rejection of an operation for another target. Four
shared SQLite/apply cases also returned `failed` instead of provider-declared
`pending` before the propagation fix. Initial mismatched hosting fixtures were
corrected before observing those four failures at the actual receipt boundary.
The native operation later completed at 21:36:48 UTC, about 16 minutes 38 seconds
after creation began. Read-only observation found the same instance `RUNNABLE`,
with only the built-in `postgres` database. This establishes successful native
instance creation, not a usable Hypervibe deployment.

Completion uses an isolated `database-provisioning-recovery` plan for the exact
retained component. Planning makes no cloud writes. It pins the provider scope,
native lifetime, role, logical database, current bindings and environment. A
missing historical password requires an explicit reviewed credential replacement;
it cannot be invented, recovered from Google, or silently installed. The review
also identifies whether the logical database needs creation. Existing databases
and data are preserved. No instance creation, deletion or application rollout is
authorized by this stage.

The encrypted review and progress are persisted before each write and immediately
after its acknowledgment. Recovery checks the same native operation and lifetime;
an attempted write without an acknowledged operation cannot be blindly repeated.
Native terminal success, SQL authentication and the exact logical database must
be verified before removing the incomplete marker. Database readiness does not
prove application migrations, runtime access, backups or restoration.

## Named provider review

The native contracts are recorded in the existing
[eight-provider matrix](../test/provider-contracts/database-provisioning-provider-matrix.json).
This review does not extend native support by adding a common receipt field.

| Provider | Native completion and recovery boundary | New completion capability |
| --- | --- | --- |
| Railway | Exact template workflow, service/environment and volume; preserve issuer configuration and storage. | Unsupported; existing initialization and recovery remain separate. |
| Supabase | Exact project reference, organization and ready managed database; ambiguous creates retain identity. | Unsupported. |
| Neon | Exact project/branch and operation readiness; endpoint replacement is not database identity. | Unsupported. |
| Cloud SQL | Exact project/instance, operation target, `RUNNABLE`, engine, region and creation lifetime. Password updates and logical database creates each return a separate native operation. | Implemented with offline coverage; live completion remains unverified. |
| RDS | Account, region, instance/ARN, available endpoint and network; existing adapter retains private credentials on partial failure. | Unsupported; no inference from the Cloud SQL path. |
| Azure PostgreSQL | Full ARM server ID and `Ready`, approved scope and native database/firewall outcomes. PUT acknowledgment is not convergence or retry authority. | Unsupported. |
| Fly Managed Postgres | Organization and cluster, exact ready state and database/user initialization. | Unsupported. |
| DigitalOcean | Account, cluster and region, exact online state and logical database. | Unsupported. |

Cloud SQL's additional native boundaries are
[users.update](https://docs.cloud.google.com/sql/docs/postgres/admin-api/rest/v1/users/update),
[databases.insert](https://docs.cloud.google.com/sql/docs/postgres/admin-api/rest/v1/databases/insert)
and [instance metadata](https://docs.cloud.google.com/sql/docs/postgres/admin-api/rest/v1/instances).
Normal acceptance must cover private persistence, confirmation, native lifetime
changes, cross-environment isolation, partial progress, restart, lost acknowledgment,
existing database preservation and no duplicate create. Offline transport checks
do not establish live recovery. The original disposable instance has not yet
been repaired; no password reset, adoption, deletion or duplicate create has been
performed.

Additional RED/GREEN checks cover the shared plan/apply and SQLite boundary,
including confirmation, existing database preservation, pending operations,
lost acknowledgments, secret-free receipts/portable exports and encrypted raw
columns. Five safety regressions initially failed: omitted documented built-in
user type, two ambiguous shared scopes, unknown operation status and a provider
error echoing the generated password. A sixth regression demonstrated that public
identity fingerprints intentionally exclude credentials; apply now separately
compares the private retained credential without publishing its hash.
Another failing regression confirmed that `RUNNABLE` alone must not bypass the
original acknowledged `CREATE` operation; completion now checks both and pins
the retained creation timestamp. Missing lifetime evidence stays unknown.

The lifecycle tests substitute PostgreSQL authentication, while separate real
PostgreSQL wire tests cover password challenge and session identity. Neither is
live GCP recovery evidence. This change preserves credentials when ordinary
provision returns incomplete; it does not make the original instance-create call
crash-atomic before its first retained receipt. Legacy missing credentials need
the explicit reset review. A lost logical-database acknowledgment remains blocked
without resubmission, even if a same-named database later appears. Native reset
has no concurrency precondition against another administrator changing a password
between review and execution; this limitation belongs in the saved owner review.
