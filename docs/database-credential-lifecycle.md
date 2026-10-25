# Database credential lifecycle evidence

The challenged assumption is that valid references, matching configured values,
or a successful deployment prove that a workload can authenticate. A concrete
counterexample is a deployment retaining an older password while current provider
variables agree: fresh connections still fail with PostgreSQL `28P01`.

## Evidence boundaries

| Layer | Evidence | What remains separate |
| --- | --- | --- |
| Raw references | Provider definition reads and issuer-reference repair readback | Resolved values and runtime use |
| Resolved configuration | Provider-rendered values, compared privately | Selected deployment configuration |
| Deployed configuration | Exact scoped deployment/snapshot plus complete active deployment inventory | Process environment and SQL authentication |
| Fresh authentication | Exact application connection configuration, intended login/session identity and database, new SQL connection | Deployed provenance, application queries and pooled connections |
| Application operation | Workload-specific HTTP/worker/job verification after activation | Other workloads and unexercised application paths |

Railway's [variable contract](https://docs.railway.com/variables) distinguishes
reference variables and staged configuration from deployment. Its
[deployment actions](https://docs.railway.com/deployments/deployment-actions)
distinguish redeploying an existing configuration from deploying current changes.
The checked-in official GraphQL schema constrains deployment/snapshot identity
and transport; its `EnvironmentVariables` scalar does not validate nested values.
The adapter additionally rejects malformed maps and unresolved references.
A snapshot is provider deployment configuration evidence, not an observation of
each live process's environment.

PostgreSQL [stores passwords on database roles](https://www.postgresql.org/docs/current/auth-password.html),
and [28P01 means invalid_password](https://www.postgresql.org/docs/current/errcodes-appendix.html).
The [official container contract](https://hub.docker.com/_/postgres) applies
initialization variables to an empty data directory. Updating `POSTGRES_PASSWORD`
on an initialized database is not proof of a SQL password change.

`hv_plan` and `hv_status` compare each declared consumer's currently resolved
database keys against its selected deployment, including `databaseEnvAliases`
and replica URL keys. They detect changes propagated through an unchanged raw
reference. No read adopts resources or writes a baseline. Unsupported reads,
ambiguous identities, partial snapshots and missing drain evidence stay unknown.
Successful deployment IDs with stale values stay pending. A partial rollout only
discharges the exact workloads with matching configuration and verified drainage.

Dedicated credential rollouts freeze the intended selected hashes encrypted in
local state and retain their original operation and deployment baseline on
retry. They require the original exact service and provider scope. Matching resolved
deployment configuration or accepted selected-key synchronization joined to exact
native/managed replacement deployments provides activation evidence. Complete
active deployment coverage is required; routing or revision coverage alone does
not prove all old processes retired. Neither path establishes SQL authentication.

`hv_db_verify_auth` / `hypervibe db verify auth` accepts a private
`credentialsRef`, `driver: "node-postgres"`, `expectedUsername`,
`expectedDatabase`, and a caller-declared `configurationSource` of `configured`
or `deployed`. The private input is the exact application URL or supported JSON
connection configuration. It uses a fresh connection, fixed read-only identity
SQL, explicit timeouts and value-free results. It does not substitute passwords,
create access paths, change TLS settings, or fall back to an administrator URL.
Caller-declared provenance is not independently verified. Unsupported drivers,
configuration options, private routing and missing evidence remain explicit.

See [rotation](database-password-rotation.md) for the dedicated resumable
spec/plan/apply path and database provider matrix, and
[runtime providers](runtime-credential-providers.md) for the hosting matrix.
SQL-only helpers do not satisfy the complete rotation capability. An uncertain
write retains the same encrypted replacement and is reconciled by observation;
it is not automatically replayed or regenerated.

## Regression and acceptance record

Before changing runtime behavior, the application-boundary regression observed
`restartRequired: false` for stale consumers and `current` for missing snapshot,
drain or exact-scope evidence. All six original cases now pass. Additional
coverage checks alias-only drift, old deployments, partial rollouts and retries.
The rollout tests independently failed when a different successful deployment
could discharge a stale or unproven configuration. Pinned-SDL transport tests
exercise the actual Railway client and independently selected deployment snapshot.

The disposable real PostgreSQL test establishes SCRAM authentication compatibility
for the supported node-postgres boundary: matching configured values and valid
references coexist with a stale URL rejected as `28P01`; the intended URL opens
a new session in the intended database. Synthetic provider/lifecycle fixtures
exercise orchestration, not live cloud provider compatibility.

These tests are included by ordinary `npm test`. Both the committed
`.github/workflows/hypervibe-acceptance.yml` and desired `.hypervibe/spec.json`
acceptance commands run `npm test` and type checking. The PostgreSQL fixture
requires local PostgreSQL binaries and fails rather than skipping if unavailable.
Live branch-protection enforcement was not checked.
