# Environment data migration

Choose how the data will move before pausing the app. Application maintenance
pauses the app while you copy data yourself. Automated data migration copies
whole databases and buckets through a separate reviewed Hypervibe plan.

## Railway to Google Cloud

Prepare a separate Cloud Run environment and check the app on its temporary
hostname. A working target does not establish that the production data can move.
The guided GCP transfer still needs a saved OpenTofu plan for the actual
copy job and a private handoff for the database dump URL and bucket credentials.
Railway PostgreSQL and Railway bucket copies that need this handoff are blocked.
A fresh comparison of private Railway and Cloud SQL databases also needs
reviewed native jobs. A historical receipt only describes the earlier copy.
The application pause and forwarding flow below is a separate capability.
Follow [the private transfer implementation](https://github.com/davejohnson/hypervibe/issues/747)
and [the GCP rehearsal](https://github.com/davejohnson/hypervibe/issues/254).

For a prepared Railway source and Cloud Run destination, preview the copy
account and its empty global Secret Manager container with
`hv_connections` action `prepare`, provider `cloudrun`,
`migrationAccess="empty-transfer-slot"`, the project, the Railway
`migrationSourceEnvironment` and the destination `environment`. Review the
saved HTML plan. To create the listed resources, repeat that request with
`confirm=true` and the exact `gcpSetupPlanId`. The third action gives the
copy account Secret Accessor on that container. Hypervibe retains these
resources in the target's managed project setup.

Once the empty secret and copy account exist, preview the next change with the
same project, source and target and `migrationAccess="restrict-app-access"`.
Review its saved HTML and supply its own `gcpSetupPlanId` to approve it.
The plan narrows two project-level grants held by the app's runtime account.
It excludes the transfer secret and its versions from the secret reader grant.
It excludes objects under `migrations/<destination>/` in the build-source
bucket from the storage grant. Object names can still appear in bucket lists.

Hypervibe creates each conditional grant before removing its broad predecessor.
If one grant was fully replaced and the other is still broad, preview the
restrictions again and review the remaining change. An interruption within
one replacement needs separate recovery. If Google still lists both grants
for the same role, or OpenTofu still tracks the previous grant, the app may
retain broad access. Keep the transfer secret empty and pause the copy.
Request recovery of that grant through Hypervibe’s managed Google Cloud setup,
then preview the restrictions again.

Hypervibe checks the direct bindings and the identities of the
account, secret and bucket. A successful change to these two grants is only
one part of verifying access. Other grants, inherited permissions and anyone
holding a signed download URL can affect who can read an export. [Google IAM resource attributes](https://docs.cloud.google.com/iam/docs/conditions-resource-attributes) · [Cloud Storage signed URLs](https://docs.cloud.google.com/storage/docs/access-control/signed-urls)

To test those permissions, preview `migrationAccess="verify-copy-access"` with
the same project, Railway source and Cloud Run destination. Review its saved
HTML, then approve a single check with its exact `gcpSetupPlanId`. To reopen
the report later, use `hv_runs` action `report` with the saved `runId`, the
Hypervibe project and the Google Cloud `gcpProjectId`.

The check places random test data in one new version of the transfer secret
and one file under the destination's export prefix. One temporary Cloud Run
job reads that version as the copy account and downloads the exact file
generation through the short-lived link stored there. A second job uses the
app account to read the same version and file directly. Both app reads must
return permission denied. Google may charge for compute, requests and storage.

Hypervibe checks cleanup of the jobs, the test version and the exact file
generation. Google keeps metadata for the destroyed secret version. The
preview shows any bucket soft-delete period, during which the deleted test
file is recoverable. A failed or unfinished check leaves access unverified.
A passing check records the two accounts' access at that time. Moving Railway
credentials and customer data still requires the separate private handoff
and approved copy plan.

For a production rehearsal, include files with known contents and eligible
queued work. Check every referenced object, run one worker against the target,
then write a new record there and verify that a restored copy contains it.
Measure the interval from pausing source writers through reopening the original
hostname. A local restore duration does not measure this interval.

GCP copy verification reads the bytes of every selected file at both endpoints.
A refresh can transfer the full selected object set again and incur provider
transfer charges. Older file-count receipts need a fresh approved copy before
they can authorize release. Controllers sharing one Hypervibe state directory
serialize migration work per destination environment. A refresh can reconcile
a recorded, completed Cloud Run execution after an interruption. If its
ownership, completion, or cleanup is uncertain, the next copy remains blocked.
Independent installations do not share this local execution lock.

### Hold a destination worker before restoring queued work

Let current jobs finish first. On Google Cloud and AWS, a fixed-size worker
can be held at zero with `services.<name>.workerPaused: true` in `hv_spec`.
Review the count change in the infrastructure plan and apply it. On Google
Cloud, use `hv_status` to verify the worker pool has zero configured
instances. On AWS, verify that the exact ECS worker has zero desired, running
and pending tasks. A pause request or missing observation leaves that check
open. Check separately that no job is in flight and that other writers,
including web services and scheduled jobs, are quiet. Set `workerPaused` to
`false` and approve the plan for one instance when processing should resume.

On-demand workers have independent wake-up mechanisms. If changing an
on-demand worker to fixed size, retire the wake-up mechanism and confirm its
outstanding executions have finished before relying on a fixed-worker pause.
Azure fixed workers run one Container Apps replica. Its managed engine
rejects the per-worker pause setting. Azure's zero minimum permits scaling
down, while changes to an image or scaling settings can provision a new
revision. [Azure worker pause follow-up](https://github.com/davejohnson/hypervibe/issues/791)

## Pause the app for a manual move

Use `maintenance.mode: "application"` when you want to copy a private database
or buckets yourself. Hypervibe first serves a Cloudflare maintenance page with
HTTP status 503, then suspends the declared scheduled jobs, background workers,
and web services. This pause does not open a database connection, change a
database write setting, or read, change, or copy bucket contents.

Add this fragment to the existing source environment through `hv_spec`, keeping
its current hosting, services, database, and storage settings:

```json
{
  "maintenance": { "enabled": true, "mode": "application" }
}
```

1. Let current jobs and uploads finish before requesting the pause. Hypervibe
   stops declared workloads; it cannot prove that an application job completed,
   an upload finished, or another client stopped writing to the database or
   buckets. Coordinate those writers separately.
2. Run a full `hv_plan` for the source, review its actions, and use `hv_apply`
   with the required confirmations. Continue only after Hypervibe verifies the
   maintenance page and suspended workloads. Unknown or incomplete results stop
   the move. Later full plans keep this app paused even if other settings drift;
   a plan limited to selected services cannot bypass the pause.
3. Prepare a separate target environment through its own `hv_spec` → `hv_plan`
   → `hv_apply` workflow. Do not change the source's hosting provider while it is
   paused. Copy the database and bucket data yourself, then verify the target
   app against those copies, including login, reads, writes, and uploads as
   relevant. An application pause does not authorize automated `dataMigration`.
4. Choose whether to return to the source or send visitors to the target using
   the steps below. Keep the source resources until the move is accepted.

Omitting `mode` keeps the existing **data maintenance** behavior, including the
PostgreSQL write fence. Always specify `"application"` for a pause that leaves
database access unchanged. Resume before changing an existing maintenance mode.

### Send visitors to the prepared target

After deploying and checking a separate environment named `next` with a public
`web` service, add this fragment to the paused **source** environment:

```json
{
  "domainTarget": { "environment": "next", "service": "web" },
  "maintenance": {
    "enabled": true,
    "mode": "application",
    "page": "off"
  }
}
```

Run a full source plan, review and apply the traffic change, then check the
existing public URL. Hypervibe verifies the target's provider-issued HTTPS URL
and keeps a Cloudflare Worker on the source hostname to forward requests there.
The source remains paused. The hostname and its existing DNS/custom-domain
ownership stay with the source; this operation does not transfer them to the
target. Keep Cloudflare proxying enabled, use a different target environment,
and do not assign the source hostname to the target or chain traffic targets.
Configure the target app for the original public URL and its trusted forwarding
settings. The Worker forwards requests to the native origin; it does not rewrite
absolute URLs generated by the app or cookie domains. Check login, redirects,
links, and uploads through the original public URL after switching.
If the result is uncertain, keep the same page and target settings and follow
Hypervibe's recovery step before requesting another traffic change. Its saved
route information is needed to verify what happened.

To show the 503 page again, set `maintenance.page: "active"`, leaving
`enabled: true`, `mode: "application"`, and `domainTarget` in place, then plan
and apply. This changes the existing route back to the page without restarting
the source. It does not stop the target or other clients from writing data.

### Resume the source

With no `domainTarget` configured, set
`maintenance: { "enabled": false, "mode": "application" }`, or remove the
maintenance field, then plan and apply. Hypervibe restores the saved workload
settings before removing its maintenance route.

If traffic was switched to the target, remove `domainTarget` and `page` while
setting `enabled: false`, then review the source's full plan. Check the source
app after applying it. Restoring source traffic and workloads does not copy
target data back or roll back changes made since the move. Decide how to handle
those writes before returning visitors to the source.

## Automated whole-resource data migration

For an automated move, the target environment declares one reviewed, one-use
`dataMigration` id and the source whose whole database and/or named buckets
should replace its data. Both environments need data maintenance; application
maintenance is insufficient and blocks automated copying.

This example uses the retained Railway workflow for both environments and
declares every resource selected for copying. It is not an example of migration
to an OpenTofu-managed cloud environment. Those destinations have separate
capability and verification requirements; see the [common cloud journey](development/user-journey.md).

```json
{
  "version": 1,
  "project": "portable-move",
  "environments": {
    "staging": {
      "hosting": { "provider": "railway" },
      "domain": "staging.example.com",
      "services": { "web": {}, "worker": { "workloadKind": "worker" } },
      "database": { "provider": "railway", "engine": "postgres" },
      "storage": {
        "documents": { "provider": "railway", "type": "bucket", "region": "sjc", "injectInto": ["web"] }
      },
      "maintenance": { "enabled": true }
    },
    "production": {
      "hosting": { "provider": "railway" },
      "domain": "example.com",
      "services": { "web": {}, "worker": { "workloadKind": "worker" } },
      "database": { "provider": "railway", "engine": "postgres" },
      "storage": {
        "documents": { "provider": "railway", "type": "bucket", "region": "iad", "injectInto": ["web"] }
      },
      "maintenance": { "enabled": true },
      "dataMigration": {
        "id": "initial-production-launch",
        "fromEnvironment": "staging",
        "include": { "database": true, "storage": ["documents"] }
      }
    }
  }
}
```

V1 deliberately copies whole resources. It does not merge rows, reconcile
application records, or infer that a provider change means data should move.
Use a new id for a new migration event.

### Automated migration workflow

1. Deploy and verify the exact application SHA intended for production while
   it still uses the existing production data bindings.
2. Declare `maintenance.enabled: true` on both source and target. Plan and apply
   each environment until `hv_status` reports `maintenance.state: active` and
   `stage: verified`. Hypervibe must prove the Cloudflare 503 marker, suspend
   every cron/worker/web workload, and enable the PostgreSQL write fence. Do not
   copy data based on a manually displayed maintenance page or an application
   flag.
3. Run `hv_plan` for the target. A pending migration produces an isolated,
   confirmation-required plan; ordinary service, DNS, CI, and datastore actions
   are excluded from this apply.
4. Review and explicitly confirm the database and storage copy action ids, then
   apply the plan. Hypervibe creates fresh unreachable targets, streams data,
   verifies database table counts/extensions and storage key/size manifests,
   and only then records the new bindings.
5. Keep both environments in desired maintenance and run `hv_plan` again. This
   plan rewires services and deploys the exact desired SHA while the public edge
   and database write fence remain active. Apply it and verify provider health
   and the migration receipt.
6. Set `maintenance.enabled: false` on production and apply the reviewed exit.
   Hypervibe removes the database fence, restores exact pre-maintenance workload
   settings, and removes only its bound Cloudflare route after fresh verification.
   Keep staging in maintenance until production is accepted or rollback is no
   longer required.
7. Run `hv_plan` once more after cutover convergence. Hypervibe can now offer
   separate confirmation-required deletion actions for any previous production
   database or bucket retained as a rollback target.
8. Remove `dataMigration` after the receipt and retained-target lifecycle are
   complete. The receipt remains in Hypervibe state.

Failed copies never replace active bindings. Hypervibe attempts to destroy a
failed fresh target; if provider cleanup fails, it retains the exact candidate
identity and blocks another candidate until cleanup succeeds.

Migration rejects identical environments and environments bound to the same
native database instance. Before replacing data, both PostgreSQL connections
must report different database identities, regardless of their URLs or login
roles. An unavailable identity query blocks the copy. Replicas or clones that
share a cluster identifier and database name also block conservatively.

If a candidate aliases an active database, or its connected identity cannot be
verified, Hypervibe preserves it and blocks automatic cleanup and retry. Review
its bindings through the supported workflow; it must not be deleted as a failed
fresh target. These checks apply to the shared transfer path and the GCP copy
worker, including private Railway exports. They do not add unavailable provider
migration destinations.

## Maintenance provider support

The edge and database controls are portable: Cloudflare uses the connected API
token already used for DNS, with `Zone > Workers Routes > Edit` and
`Account > Workers Scripts > Edit` added to that token; PostgreSQL uses the
operation-scoped database access already owned by the database adapter. No
second Cloudflare key or provider-specific maintenance credential is required.
Workload suspension is currently:

| Hosting provider | Maintenance behavior |
| --- | --- |
| Railway | Removes the exact active deployment, preserves replicas/sleep/cron settings, and redeploys it on exit. This does not prove application jobs or uploads finished gracefully. |
| GCP Cloud Run | Supports the fixed-worker setting above. Whole-app workload maintenance is unavailable on the managed engine. |
| AWS ECS | Supports the fixed-worker setting above. Whole-app workload maintenance is unavailable on the managed engine. |
| Azure Container Apps | Whole-app workload maintenance and individual fixed-worker pause are unavailable on the managed engine. |

This matrix is deliberate. A provider is not marked supported until Hypervibe
can stop background work and direct origins, retain exact restoration state,
and verify both directions using its ordinary connection credentials.

Provider stop/scaling operations do not prove that in-flight HTTP requests,
uploads, or persistent-worker jobs completed. Finish that work before pausing.
The behavior above describes Hypervibe's implemented lifecycle; offline tests
alone do not establish live compatibility for a particular app or provider
account. Verify each transition through the current provider observations and
check the app after resuming or switching traffic.

## Provider portability

PostgreSQL transfer uses `pg_dump`/`pg_restore` against bounded provider access.
Provider adapters only provision resources and expose operation-scoped access,
so Railway, RDS, Cloud SQL, Azure Database for PostgreSQL, and
other PostgreSQL providers use the same transfer engine. Installed PostgreSQL
client tools must be compatible with the source server version.

Object transfer uses a provider-neutral streaming port. Railway and Amazon S3
use the built-in S3 stream; Google Cloud Storage and Azure Blob Storage expose
their native list/get/put streams through the same contract. A migration can
therefore copy among `railway`, `s3`, `gcs`, and `azureblob` without changing
the orchestration. A storage provider name is valid only when Hypervibe has a
registered adapter for it; unsupported providers block rather than silently
falling back.

## Read replicas

Read replicas are not the portable migration mechanism. A provider-native
replica is usually constrained by provider, account, region, engine version,
network topology, or proprietary control-plane rules. It is excellent for read
scaling and resilience after production is live, and a same-provider replica may
serve as an operational source for a later snapshot.

Cross-provider near-zero-downtime moves require a separate logical-replication
lifecycle: connectivity, publications/subscriptions, DDL coordination, sequence
reconciliation, lag observation, and a final write freeze. That is materially
more complex than this snapshot baseline and should be added only when measured
downtime requirements justify it.
