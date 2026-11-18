# Engine database access

AWS and Azure database operations use the engine environment and its verified
repository-scoped cloud connection. They do not require the removed ECS or Azure
Container Apps hosting adapters, a PostgreSQL command-line tool, or direct cloud
setup. GCP's Cloud SQL connector and existing Railway access are preserved.

## Targets and authority

Successful database-login apply actions now save native cluster/server identity,
provider scope, environment database and login. AWS saves the native ARN of an
environment-owned query credential; Azure saves its exact Key Vault reference. A read validates this identity against the native provider
before opening SQL. Conflicting engine/legacy targets, a different cloud account
or subscription, incomplete responses, or a retired environment block access.

Older bindings can be recovered privately from the project's shared engine state
and that environment's engine state. The shared resource supplies the native
server identity; the environment's existing runtime credential reference supplies
the exact database and login. Project or environment names are never used to guess
them. Recovery is read-only and does not persist a binding, create a component,
change credentials, or repair infrastructure. An older environment without both
state records and an environment-owned runtime reference remains blocked.

AWS uses the Aurora Data API authenticated as the environment's application login,
never the administrator login. A reviewed engine plan creates one Secrets Manager
credential resource per immutable environment ID, with the associated storage
charge. The approved login operation writes the same application credential to
Parameter Store and that secret. Existing environments require `hv_plan` and
`hv_apply` to add this capability; the upgrade copies their existing application
credential privately without changing the password. Missing, ambiguous or unowned
query-credential evidence blocks SQL. The administrator credential is used only
by approved database administration, not by diagnostics.

Each diagnostic access session has temporary IAM permissions restricted to the
exact cluster and application secret. Every transaction verifies `session_user`,
`current_user` and `current_database()` before running caller SQL. Default reads
set PostgreSQL transaction read-only mode and a statement timeout; the client does
not use `SET ROLE` to substitute for authentication. Parameters stay bound, results
are bounded to 500 rows and 512 KiB, and reads roll back. Integer and decimal values
use Data API's string format to avoid silent precision loss. Confirmed mutation
statements commit; uncertain writes are not retried. A definite database-resuming
rejection receives retries within a total 40-second connection window, including
provider response time. If Aurora is still resuming, the error asks the user to
wait and retry without suggesting a SQL or access problem. Explicit rejected
connections do not claim an unknown transaction; transport failures and missing
transaction identities still do. Oversized mutation results report whether
rollback was confirmed when the query ended. Failed rollback remains visible in
the command result. No secret values enter engine state or command output.

Azure reads the environment-owned Key Vault connection URL privately, checks its
host, database and login against the accepted binding, and uses the bundled
PostgreSQL client with certificate and hostname verification. Existing query
transaction, timeout, result bounds and connection cleanup apply. Query never
adds firewall rules. If public access is disabled or unknown, a managed private
connector or an approved engine network change is required; the connector is not
implemented. Since 2026-11-17 the Azure engine turns public access off (#728),
so queries against Azure engine databases are refused. Both providers' public inspection/status results separate server
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

- Real AWS SDK request/response serialization for scoped role assumption, native cluster
  and credential metadata reads, Data API application authentication, read-only transactions, bound parameters, resume, failure,
  response bounds, and failed cleanup, through the public MCP command.
- Azure OAuth, ARM and Key Vault HTTP requests and real `pg` query serialization
  against a synthetic PostgreSQL wire peer. TLS configuration is asserted;
  certificate validation and live network reachability are unverified.
- Private engine-state projection, renamed environments, duplicate/unknown native
  identities, wrong environment references, worker-only sources, native operational
  connection selection, and migration identity separation.
- A disposable real PostgreSQL regression reproduces the prior administrator-session
  escape through `set_config('role', 'none', true)` and `query_to_xml` inside a read-only
  query. The same public access path now authenticates as the application login and
  cannot read the administrator-owned table. This test runs in ordinary `npm test`.
- Approved-login tests verify that initial credentials match in both stores, upgrades
  preserve the existing password without administrator SQL, and conflicting URLs stop.
- Existing Railway/GCP public database command and retained RDS/Azure adapter tests.

The cloud responses are reconstructed offline fixtures. The local PostgreSQL
regression establishes the authentication and role-isolation boundary; it is not
a live Aurora test. These checks do not establish live IAM permissions, firewall
reachability, certificates, Aurora resume timing, or successful production queries. No cloud resources were
created or changed during this work.

Primary contracts reviewed on 2026-11-16:

- [AWS BeginTransaction](https://docs.aws.amazon.com/rdsdataservice/latest/APIReference/API_BeginTransaction.html),
  [ExecuteStatement](https://docs.aws.amazon.com/rdsdataservice/latest/APIReference/API_ExecuteStatement.html),
  [CommitTransaction](https://docs.aws.amazon.com/rdsdataservice/latest/APIReference/API_CommitTransaction.html),
  [RollbackTransaction](https://docs.aws.amazon.com/rdsdataservice/latest/APIReference/API_RollbackTransaction.html).
  Exact success statuses use the [commit example](https://docs.aws.amazon.com/cli/latest/reference/rds-data/commit-transaction.html) and
  [rollback example](https://docs.aws.amazon.com/cli/latest/reference/rds-data/rollback-transaction.html):
  `Transaction Committed` and `Rollback Complete`.
- [Data API credential authorization](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/data-api.access.html),
  [STS session-policy intersection](https://docs.aws.amazon.com/STS/latest/APIReference/API_AssumeRole.html),
  and [Data API JSON numeric formats](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/data-api-json.html).
- [Azure Flexible Server GET, API 2024-08-01](https://learn.microsoft.com/en-us/rest/api/postgresql/servers/get?view=rest-postgresql-2024-08-01).
- [PostgreSQL read-only transactions](https://www.postgresql.org/docs/17/sql-set-transaction.html)
  and [wire message formats](https://www.postgresql.org/docs/17/protocol-message-formats.html).
