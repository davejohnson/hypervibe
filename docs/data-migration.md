# Environment data migration

Hypervibe treats moving durable data as desired state, not as an imperative
database command or an environment rename. The target environment declares one
reviewed, one-use migration id and the source environment whose whole resources
should replace its database and/or named buckets.

```json
{
  "environments": {
    "production": {
      "database": { "provider": "rds", "engine": "postgres" },
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
2. Put the source environment into maintenance mode and stop every writer,
   including workers, cron jobs, external ingestion, and direct operator writes.
3. Run `hv_plan` for the target. A pending migration produces an isolated,
   confirmation-required plan; ordinary service, DNS, CI, and datastore actions
   are excluded from this apply.
4. Review and explicitly confirm the database and storage copy action ids, then
   apply the plan. Hypervibe creates fresh unreachable targets, streams data,
   verifies database table counts/extensions and storage key/size manifests,
   and only then records the new bindings.
5. Run `hv_plan` again. This plan rewires services and deploys the exact desired
   SHA. Apply it, verify health and application-level smoke checks, then switch
   production DNS if the hostname is not already managed by production.
6. Run `hv_plan` once more after cutover convergence. Hypervibe can now offer
   separate confirmation-required deletion actions for any previous production
   database or bucket retained as a rollback target.
7. Remove `dataMigration` after the receipt and retained-target lifecycle are
   complete. The receipt remains in Hypervibe state.

Failed copies never replace active bindings. Hypervibe attempts to destroy a
failed fresh target; if provider cleanup fails, it retains the exact candidate
identity and blocks another candidate until cleanup succeeds.

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
