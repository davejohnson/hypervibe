# Engine database access

AWS and Azure database operations use the engine environment and its verified
repository-scoped cloud connection. They do not require the removed ECS or Azure
Container Apps hosting adapters, a PostgreSQL command-line tool, or direct cloud
setup. GCP's Cloud SQL connector and existing Railway access are preserved.

## Targets and authority

Successful database-login apply actions now save native cluster/server identity,
provider scope, environment database and login. Azure also saves its exact Key
Vault secret reference. A read validates this identity against the native provider
before opening SQL. Conflicting engine/legacy targets, a different cloud account
or subscription, incomplete responses, or a retired environment block access.

Older bindings can be recovered privately from the project's shared engine state
and that environment's engine state. The shared resource supplies the native
server identity; the environment's existing runtime credential reference supplies
the exact database and login. Project or environment names are never used to guess
them. Recovery is read-only and does not persist a binding, create a component,
change credentials, or repair infrastructure. An older environment without both
state records and an environment-owned runtime reference remains blocked.

AWS uses the Aurora Data API with a transaction for every query. Default reads set
PostgreSQL transaction read-only mode, assume the accepted environment owner role,
and set a statement timeout. Parameters stay bound, results are bounded to 500
rows and 512 KiB, and reads roll back. Confirmed mutation statements commit;
uncertain writes are not retried. A definite database-resuming rejection receives
bounded retries. Failed rollback remains visible in the command result. Master
credentials remain in Secrets Manager; Data API receives only its scoped reference.
An administrative query does not prove the application's password authenticates.

Azure reads the environment-owned Key Vault connection URL privately, checks its
host, database and login against the accepted binding, and uses the bundled
PostgreSQL client with certificate and hostname verification. Existing query
transaction, timeout, result bounds and connection cleanup apply. Query never
adds firewall rules. If public access is disabled or unknown, a managed private
connector or an approved engine network change is required; the connector is not
implemented. Both providers' public inspection/status results separate server
presence from unverified SQL authentication and application credential alignment.

Migration source summaries can use Data API. PostgreSQL socket transfers cannot;
those operations report the missing managed connector. Logical databases on the
same engine-managed shared server remain distinct in migration identity checks;
the same logical database is rejected as a self-copy.

## Evidence and limits

The failing public MCP command returned `No postgres component is tracked` for an
accepted AWS engine database with no legacy component. A working GCP engine binding
without a component is the counterexample to that assumption. Added regression
coverage runs in ordinary `npm test`:

- Real AWS SDK request/response serialization for role assumption, native cluster
  reads, Data API read-only transactions, bound parameters, resume, failure,
  response bounds, and failed cleanup, through the public MCP command.
- Azure OAuth, ARM and Key Vault HTTP requests and real `pg` query serialization
  against a synthetic PostgreSQL wire peer. TLS configuration is asserted;
  certificate validation and live network reachability are unverified.
- Private engine-state projection, renamed environments, duplicate/unknown native
  identities, wrong environment references, worker-only sources, native operational
  connection selection, and migration identity separation.
- Existing Railway/GCP public database command and retained RDS/Azure adapter tests.

These are reconstructed offline fixtures, not recorded cloud responses or live
SQL runs. They establish command integration and serialized contracts, not live
IAM permissions, firewall reachability, certificates, Aurora resume timing, SQL
role memberships, or successful production queries. No cloud resources were
created or changed during this work.

Primary contracts reviewed on 2026-11-16:

- [AWS BeginTransaction](https://docs.aws.amazon.com/rdsdataservice/latest/APIReference/API_BeginTransaction.html),
  [ExecuteStatement](https://docs.aws.amazon.com/rdsdataservice/latest/APIReference/API_ExecuteStatement.html),
  [CommitTransaction](https://docs.aws.amazon.com/rdsdataservice/latest/APIReference/API_CommitTransaction.html),
  [RollbackTransaction](https://docs.aws.amazon.com/rdsdataservice/latest/APIReference/API_RollbackTransaction.html).
  Exact success statuses use the [commit example](https://docs.aws.amazon.com/cli/latest/reference/rds-data/commit-transaction.html) and
  [rollback example](https://docs.aws.amazon.com/cli/latest/reference/rds-data/rollback-transaction.html):
  `Transaction Committed` and `Rollback Complete`.
- [Azure Flexible Server GET, API 2024-08-01](https://learn.microsoft.com/en-us/rest/api/postgresql/servers/get?view=rest-postgresql-2024-08-01).
- [PostgreSQL read-only transactions](https://www.postgresql.org/docs/17/sql-set-transaction.html)
  and [wire message formats](https://www.postgresql.org/docs/17/protocol-message-formats.html).
