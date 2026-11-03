# Durable manual recovery task evidence

A one-use local backup request needs retained progress before each native effect.
The existing scheduled helper's in-process variables cannot authorize recovery
after the coding session stops. The shared checkpoint stores only an authority
digest, a phase, bounded resource coordinates and terminal status. The caller
reserves the request and atomically saves/reloads each checkpoint. The provider
validates its own exact native coordinates and rejects contradictory phase history.

The optional capability `recoveryTasks.durableProgress` admits this path. Ordinary
`runJob` support and the existing scheduled recovery capability do not imply it.
The helper image protocol, scheduled source-authority checks and existing archives
are unchanged. Manual execution does not activate a recurring schedule or certify
native point-in-time restore or application compatibility.

| Hosting provider | Native task boundary reviewed | This capability |
| --- | --- | --- |
| Cloud Run | A named Job create returns an Operation; a separate run creates an Execution. Correlate full project/location/job paths, immutable Job and Execution UIDs, exact template and terminal Task evidence. Delete with the freshly read etag, then prove absence. | Implemented, ready for live validation; Cloud SQL and GCS only. |
| ECS | RunTask returns task identities under a cluster and accepts its own client token; native consistency and task-definition authority differ from Cloud Run operations. | Unsupported; no durable manual recovery adapter. |
| Azure Container Apps | Job definitions and their executions have separate start/completion identities and managed-identity configuration. | Unsupported; no durable manual recovery adapter. |
| Railway | The existing private helper uses project/environment/service/deployment identities. Its scheduled execution is not this persisted task capability. | Unsupported; no durable manual recovery adapter. |
| Fly | Machine identity and current instance identity are distinct; native start/stop/delete and lease behavior need their own contract. | Unsupported; no durable manual recovery adapter. |
| DigitalOcean | App Platform deployment jobs and cron jobs have app/deployment execution scope. | Unsupported; no durable manual recovery adapter. |
| Vercel | Cron invokes deployed functions; that does not establish a private immutable backup-container lifecycle. | Unsupported; no durable manual recovery adapter. |

Official sources reviewed on 2026-11-02:

- Cloud Run [create](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.jobs/create), [run](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.jobs/run), [delete Job](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.jobs/delete) and [delete Execution](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.jobs.executions/delete).
- AWS [RunTask](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_RunTask.html).
- Azure [Container Apps jobs](https://learn.microsoft.com/en-us/azure/container-apps/jobs).
- Railway [cron jobs](https://docs.railway.com/guides/cron-jobs), plus the existing pinned Railway GraphQL transport fixtures for private task execution.
- Fly [Machines resource](https://docs.fly.io/machines/api/machines-resource).
- DigitalOcean [App Platform jobs](https://docs.digitalocean.com/products/app-platform/how-to/manage-jobs/).
- Vercel [cron jobs](https://vercel.com/docs/cron-jobs).

The Cloud Run run request has no client idempotency token in its documented body.
An uncertain create or run without a retained operation remains pending; matching
names or archive files do not authorize another request or establish ownership.
A retained acknowledged operation can be read back and its exact UID verified.
After an uncertain delete, confirmed absence advances cleanup; a still-present or
unknown resource never causes another DELETE or deletion of its parent. Persistence
failure stops dependent mutations, including the legacy automatic cleanup path.

Observed offline counterexamples: the old path ignored a failing persistence
callback and retained no checkpoint; both regressions failed before adding the
optional path. A second boundary test showed a backwards phase with a later run
operation could rerun a task; phase/coordinate validation now rejects it. Tests
exercise the real serialized client with reconstructed REST responses, restart
from retained progress, acknowledged-operation recovery, lost create/run/delete
responses, native identity drift, and unchanged no-hook behavior. Prior redacted
native execution parent-name evidence remains documented in
[prepared hosting](connect-cloud-prepared-hosting.md#native-execution-readback).

These checks run in ordinary `npm test`. They establish offline lifecycle behavior,
not live credentials, IAM propagation, networking, helper restore success, costs or
all-provider backup support. A successful retained SQL restore and separately
verified temporary-resource cleanup are still required for live acceptance.

## Local plan and authority boundary

`backups.run.id` is an explicit one-use request selected only by
`hv_plan scope="backups"`. Its saved `backup-run` plan freezes the existing
source, destination, immutable helper, native backup identity, exact secret
reference and local environment bindings. It contains one confirmed billable,
data-bearing action. It does not create prerequisites, publish workflows, change
the repository root spec, deploy applications or advance the deployment marker.
The environment must already have a prepared native backup runtime; remove the
one-use request while separately reviewing missing setup prerequisites.

The permanent local-only `manualRecovery` record reserves the request before
execution. It survives request removal and is excluded from repository export;
repository import cannot supply or replace it. Each progress update checks the
current spec revision, encrypted component identity, exact environment-scoped
connection selection, and complete environment binding snapshot. Atomic
compare-and-swap plus independent readback prevents stale writers from replacing
unrelated state or losing uncertain operations. The same checks run before the
archive completion marker's conditional write. Completion links that marker to
the acknowledged native execution, and later no-op checks inspect that exact set.
A different healthy set cannot stand in for it.

Local execution uses current verified connection adapters. Hosted deployment
approval, administrator credentials, GitHub automation credentials and runtime
reader permissions are separate purposes. The scheduled source-authority verifier
is unchanged, including exact repository/default-branch checks. The native worker
protocol is unchanged and continues to use only its dedicated identity and immutable
secret reference. The current local path never applies the recurring retention
algorithm: all prior completed and partial sets remain untouched.

Observed application regressions: the original strict schema rejected the one-use
request; callback checks initially missed component/spec/connection changes; and a
repository/global connection snapshot missed revocation of the selected environment
connection. Real command, SQLite and saved-plan tests observed those failures before
correction. A deployment-only hosted grant was also rejected after an observed
admission counterexample. Tests exercise exact confirmation, pending restart,
changed authority, forged plans, import rejection, prior archive preservation and
completed no-op. A combined consumer test uses the real local executor, manifest
producer and archive coordinator through SQLite completion, with explicitly
synthetic SQL restore and provider observations. It does not claim a live SQL restore.

Normal acceptance is declared by `.hypervibe/spec.json` (`acceptance`, `npm test`
and typecheck) and emitted in `.github/workflows/hypervibe-acceptance.yml`.
This review verifies repository configuration, not live branch-protection enforcement.
