# Environment data migration

Hypervibe treats moving durable data as desired state, not as an imperative
database command or an environment rename. The target environment declares one
reviewed, one-use migration id and the source environment whose whole resources
should replace its database and/or named buckets.

```json
{
  "environments": {
    "staging": {
      "hosting": { "provider": "railway" },
      "domain": "staging.example.com",
      "services": { "web": {}, "worker": { "workloadKind": "worker" } },
      "database": { "provider": "railway", "engine": "postgres" },
      "maintenance": { "enabled": true }
    },
    "production": {
      "hosting": { "provider": "cloudrun" },
      "domain": "example.com",
      "services": { "web": {}, "worker": { "workloadKind": "worker" } },
      "database": { "provider": "rds", "engine": "postgres" },
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

## Operator workflow

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

## Maintenance provider support

The edge and database controls are portable: Cloudflare uses the connected API
token already used for DNS, with `Zone > Workers Routes > Edit` and
`Account > Workers Scripts > Edit` added to that token; PostgreSQL uses the
operation-scoped database access already owned by the database adapter. No
second Cloudflare key or provider-specific maintenance credential is required.
Workload suspension is currently:

| Hosting provider | Maintenance behavior |
| --- | --- |
| Railway | Removes the exact active deployment, preserves replicas/sleep/cron settings, and redeploys it on exit. |
| GCP Cloud Run | Sets manual service scaling to zero, pauses scheduler jobs, and restores the exact prior scaling/schedule state. |
| Azure Container Apps | Uses the provider stop/start lifecycle and verifies terminal running state. |
| AWS ECS Express | Unsupported; plans fail closed. |
| DigitalOcean App Platform | Archives the exact bound app, verifies that App Platform reports zero running component instances, and restores the exact prior maintenance spec without changing component scaling, autoscaling, schedules, ingress, or commands. Ready for opt-in live maintenance conformance. |
| Vercel | Pauses the exact bound Project, verifies direct production origins, preserves an already-paused Project, and unpauses without redeploying. Ready for opt-in live maintenance conformance. |

This matrix is deliberate. A provider is not marked supported until Hypervibe
can stop background work and direct origins, retain exact restoration state,
and verify both directions using its ordinary connection credentials.

## Provider portability

PostgreSQL transfer uses `pg_dump`/`pg_restore` against bounded provider access.
Provider adapters only provision resources and expose operation-scoped access,
so Railway, RDS, Cloud SQL, Azure Database for PostgreSQL, Supabase, Neon, and
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
