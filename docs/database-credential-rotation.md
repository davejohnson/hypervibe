# Database credential rotation evidence

Database rotation changes actual PostgreSQL authentication before distributing the
accepted replacement. It uses the existing credential plan, encrypted plan inputs,
component bindings, consumer synchronization and managed rollout. There is no
second credential store or imperative synchronization path.

The challenged assumption was that changing a stored password or a hosting
variable rotates database authentication. A PostgreSQL server continuing to accept
the previous password while rejecting the replacement falsifies that assumption.
Another counterexample is a lost reset response: blindly retrying a
provider-generated reset changes the credential again and strands consumers that
received the first replacement.

## Reviewed provider contracts

| Registered provider | Actual authentication update | Bound identity and recovery |
| --- | --- | --- |
| Railway | PostgreSQL `ALTER ROLE` through the existing temporary access lease; then additive `POSTGRES_PASSWORD` issuer update with `skipDeploys: true`. | Exact project, environment, service, database and SQL session user. Copied aliases must first pass the existing `database-credential-aliases` reviewed plan; authored references remain intact. A fresh password connection recovers uncertain SQL, and exact issuer readback recovers its separate metadata update. |
| Supabase | The managed `postgres` owner uses `PATCH /v1/projects/{ref}/database/password`; explicitly bound other roles use their own PostgreSQL session. | Project and organization/region bindings, exact SQL user/database. The replacement is frozen before mutation; an independent fresh connection proves authentication. |
| Neon | PostgreSQL `ALTER ROLE` for the existing bound role. | Project/account plus branch and endpoint bindings. A supplied frozen password avoids a second API-generated password on retry. Fresh authentication confirms the result. |
| Cloud SQL | `users.update` sends only the exact user's name and frozen password. | Bound GCP project/instance and database/user. The returned operation and its completion must belong to that project/instance. Operation completion and fresh SQL authentication are separate evidence. |
| Amazon RDS | `ModifyDBInstance` changes the bound master password; a separately bound non-master role uses its own PostgreSQL session. A Secrets Manager-owned master uses `RotateMasterUserPassword` and retains provider ownership. | Bound AWS account/region/instance plus database/user and, for managed credentials, exact secret ARN. Unrelated pending instance modifications block `ApplyImmediately`. Generated-reset SDK retries are disabled; the existing Secrets Manager reader recovers the exact user's new password. A fresh connection confirms actual authentication. |
| Azure PostgreSQL | Flexible Server `PATCH` changes only `administratorLoginPassword`; an explicitly bound non-admin role uses its own PostgreSQL session. | Exact subscription/resource group/server identity and SQL database/user. Existing ARM long-operation handling is reused, then a fresh SQL connection verifies authentication. |
| Fly Managed Postgres | MPG v2 `POST /v1/postgres/{id}/users/{username}/rotate_password`, preserving existing sessions. | Exact organization, cluster and username. The provider generates the replacement; encrypt it immediately. After a lost response, read the exact user's `/credentials` endpoint and compare with the frozen prior value; do not generate again. |
| DigitalOcean PostgreSQL | `POST /v2/databases/{id}/users/{username}/reset_auth`. | Exact account/region/cluster and username. The provider generates the replacement; recover a lost response with the exact user's GET, comparing with the frozen prior value before accepting it. |

Provider generation is an explicit reviewed input mode. An API that generates a
password must not be treated as accepting a locally chosen password.

Same-user password rotation invalidates the previous password for new connections
as soon as the database accepts the change. Existing sessions may remain open.
The plan must explain that disruption before mutation; this is not an overlapping
two-credential rotation with a later optional revocation. Application rollout and
old-instance coverage remain separate requirements. Authentication proves a new
connection with the exact database/user, not the application's business operation.
Railway's authored password references require URI-unreserved password characters;
Hypervibe's existing base64url generator satisfies that constraint. A replacement
that would break those references is refused before changing SQL authentication.

## Independent official sources

- PostgreSQL [ALTER ROLE](https://www.postgresql.org/docs/18/sql-alterrole.html),
  [password authentication](https://www.postgresql.org/docs/17/auth-password.html),
  and [wire message formats](https://www.postgresql.org/docs/17/protocol-message-formats.html).
- Railway [variables](https://docs.railway.com/guides/variables) and the existing
  pinned GraphQL schema under `test/provider-contracts/railway` establish additive
  variable updates and deployment deferral. PostgreSQL establishes authentication.
- Supabase [database password update](https://supabase.com/docs/reference/api/v1-update-database-password)
  and [database roles](https://supabase.com/docs/guides/database/postgres/roles).
- Neon [official role documentation source](https://github.com/neondatabase/website/blob/main/content/docs/manage/roles.md)
  describes chosen-password SQL updates and branch scope.
- Cloud SQL [users.update](https://cloud.google.com/sql/docs/postgres/admin-api/rest/v1/users/update)
  and [operations](https://cloud.google.com/sql/docs/postgres/admin-api/rest/v1/operations).
- RDS [ModifyDBInstance](https://docs.aws.amazon.com/AmazonRDS/latest/APIReference/API_ModifyDBInstance.html)
  describes master password updates and `ApplyImmediately` effects; its
  [managed password contract](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-secrets-manager.html)
  establishes provider-generated rotation and the exact managed secret ARN.
- Azure [Flexible Server update](https://learn.microsoft.com/en-us/rest/api/postgresql/servers/update?view=rest-postgresql-2025-08-01)
  defines `administratorLoginPassword` and ARM completion.
- Fly's [official API client](https://github.com/superfly/fly-go/blob/master/flaps/flaps_managed_postgres.go)
  and [official MPG v2 CLI](https://github.com/superfly/flyctl/blob/master/internal/command/mpg/v2/run_users.go)
  define the exact reset path, no automatic reset retry, credentials readback and
  the distinction between new connections and existing sessions.
- DigitalOcean [database API](https://docs.digitalocean.com/reference/api/reference/databases/)
  defines generated `reset_auth` and exact-user credential readback;
  [PostgreSQL role restrictions](https://docs.digitalocean.com/products/databases/postgresql/how-to/modify-user-privileges/)
  make a universal administrative SQL assumption unsafe.

## Executable evidence and limits

`test/provider-contracts/database-credential-provider-contracts.test.ts` requires
every registered PostgreSQL provider to implement the port. It exercises real REST
clients, AWS Query serialization and response parsing using reconstructed official
responses, including generated-password uncertainty and native operation identity.
Railway issuer tests execute its real GraphQL client against the pinned SDL and
synthetic state, preserving aliases and refusing an absent environment.

`database-credential.wire.test.ts` executes the real `pg` client against a synthetic
PostgreSQL v3 wire peer. It checks parameter serialization, fresh authentication,
old-password rejection, and lost COMMIT recovery. The wire regression first exposed
an unhandled client connection-loss event; the fixed operation now reports unknown
without crashing. The peer does not execute a real PostgreSQL server.

`src/application/__tests__/database-authentication.test.ts` also runs the native
rotation port against a disposable local PostgreSQL server with SCRAM. It proves
that editing the configured password leaves authentication unchanged; an actual
role password update accepts the replacement and rejects the old password for
new connections, while an existing authenticated session remains usable. The
seven real-engine tests passed. This checks PostgreSQL behavior independently of
the synthetic transport fixtures; it does not establish cloud account access.

The initial provider roster and native-update tests failed because the ports and
issuer method were absent, then passed after implementation. Required ordinary
`npm test` includes these files. Both `.github/workflows/hypervibe-acceptance.yml`
and `.hypervibe/spec.json` configure `npm test` and TypeScript checking; repository
configuration alone does not establish live branch-protection enforcement.
The Cloud SQL regression also demonstrated an unrelated operation being accepted
as password-update completion; exact operation/project/instance correlation now
keeps that observation unknown. RDS generated-mode recovery was observed failing
before its Secrets Manager ownership handling was added.

Provider tests are offline safety and protocol checks; the disposable PostgreSQL
test executes a real local database. No cloud or customer credential was changed
during this development work. Actual account permissions, network access,
provider execution and application behavior are established by the user's
reviewed apply and its distinct authentication, deployment and health evidence.
