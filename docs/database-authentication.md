# Database authentication evidence

`hv_db_verify_auth` / `hypervibe db verify auth` opens one fresh connection using
the exact application configuration resolved privately through `credentialsRef`.
Provide the expected PostgreSQL username and **database**, plus the explicit
`node-postgres` driver. A URL or JSON object with `connectionString` and optional
`ssl`, `options`, `application_name`, `client_encoding`, and
`enableChannelBinding` is accepted. Certificate material belongs in the private
JSON input; URL options that read arbitrary certificate files are unsupported.

The command executes fixed identity SQL in a read-only transaction, checks
`session_user`, `current_user`, and `current_database()`, then closes the session.
It preserves the application's endpoint, password, TLS and startup options.
Connection, statement and query deadlines are bounded at five seconds each.
Unspecified settings cannot silently inherit conflicting `PG*` options from the
agent process. Unknown drivers, URI identity overrides and unsupported options
are rejected. There are no provider API calls, credential mutations, alternate
endpoints, tunnels, firewall rules, proxy creation, or plaintext persistence.

For a private reference already available on the credential reader's machine:

```json
{
  "credentialsRef": "env:APP_DATABASE_CONNECTION_CONFIG",
  "driver": "node-postgres",
  "expectedUsername": "postgres",
  "expectedDatabase": "railway",
  "configurationSource": "configured"
}
```

`configurationSource` is caller-declared provenance. Even the value `deployed`
does not prove that this input came from a running workload. A successful result
proves a fresh session from this machine with that input, not workload routing,
old deployment retirement, application queries, or deployed configuration.
Those layers remain explicitly unchecked. A server `28P01` is an authentication
rejection; TLS, routing, timeouts, unavailable configuration and other errors
remain unknown or invalid. Error messages and rejected input values never leave
this boundary. Re-running the check opens a new session; it makes no recovery
mutations and does not clear rollout requirements.

The independent contracts are PostgreSQL's
[SQLSTATE table](https://www.postgresql.org/docs/current/errcodes-appendix.html),
[session identity functions](https://www.postgresql.org/docs/current/functions-info.html),
and the exact installed node-postgres client's
[connection settings](https://node-postgres.com/apis/client) and
[TLS precedence](https://node-postgres.com/features/ssl). Configuration equality
and an administrative query are not proofs of application authentication.

## Provider review

All eight managed database providers share this boundary only when the operator
already possesses a usable, exact node-postgres application configuration.
Provider-side configuration retrieval, execution in the workload's private
network, driver substitution, IAM/token refresh, and deployment attestation are
unsupported by this command. No live provider compatibility is claimed.

| Provider | Native connection distinction and prerequisite |
| --- | --- |
| `railway` | [Service references and private networking](https://docs.railway.com/databases/postgresql) differ from external TCP proxy URLs. A private hostname is not replaced with a public proxy. Existing routing is required. |
| `supabase` | [Direct and pooled connections](https://supabase.com/docs/guides/database/connecting-to-postgres) have distinct endpoints and may use qualified pooler logins. A login rewritten to another session identity is unsupported; a direct administrative URL cannot substitute for the app URL. |
| `neon` | [Connection strings](https://neon.com/docs/connect/connect-from-any-app) select endpoint, database, role and TLS; pooled and direct endpoints remain distinct. HTTP/WebSocket serverless drivers are unsupported here. |
| `cloudsql` | [Network path, connector and authentication](https://docs.cloud.google.com/sql/docs/postgres/connection-options) are separate choices. This command does not initialize a connector or acquire IAM credentials. |
| `rds` | [Public/private VPC reachability](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_ConnectToPostgreSQLInstance.html) precedes PostgreSQL authentication. No security-group change or IAM token issuance occurs. |
| `azure-postgres` | [TLS client settings and CA trust](https://learn.microsoft.com/en-us/azure/postgresql/security/security-tls) must match the app; TLS failure never causes a less strict retry. Entra token issuance is unsupported. |
| `fly` | [Managed Postgres client configuration](https://fly.io/docs/mpg/client-configuration/) distinguishes pooled and direct URLs and private routing. No WireGuard or proxy setup occurs. |
| `digitalocean` | [Connection details, SSL and trusted sources](https://docs.digitalocean.com/products/databases/postgresql/how-to/connect/) are required independently. The supplied application target is retained exactly. |

## Regression evidence

The challenged assumption is that valid references plus matching configured
values establish functioning database credentials. The counterexample keeps
`DATABASE_URL` and `POSTGRES_DB_URL` references/configuration aligned while an old
consumer URL fails a **fresh real SCRAM PostgreSQL connection** with `28P01`.
The initial command-boundary regression failed with `NOT_FOUND` before this
verification capability existed. It now distinguishes rejected old input from
authenticated current input and rejects a schema name (`public`) as the expected
database. TLS failure, malformed private input, unsupported URL overrides and
the actual MCP/CLI shared result boundary are covered. The PostgreSQL instance
is disposable and local; no customer database is used.

The Railway alignment regression separately failed because the declared
`POSTGRES_DB_URL` consumer was omitted. It now passes through the real GraphQL
client, pinned schema and public MCP command. These provider responses are
synthetic, not a live incident recording. Raw references, deployed configuration,
SQL authentication and application operation are explicitly distinguished.
When accepted desired state cannot be read, independent inspection continues
with database alias coverage explicitly unknown; it neither adopts repository
edits nor invents missing alias declarations.

Both suites run under ordinary `npm test`. The committed acceptance workflow and
desired required acceptance command include that suite and type checking; live
branch-protection enforcement is unverified. Successful local PostgreSQL
authentication does not certify any provider's network, TLS or application
operation.
