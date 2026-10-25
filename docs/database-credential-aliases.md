# Database credential aliases

Reviewed 2026-10-24. This is the provider review and implementation contract for
repairing references to an existing database credential. It is separate from
SQL password rotation. Railway is the only provider
supported to implement initially; this review does not establish live support.

The challenged assumption is that equal resolved values prove that aliases will
follow their issuer. A copied password and a native reference can resolve to the
same value today; only the reference follows a later issuer change. Conversely,
a correct reference to a stale canonical password does not establish SQL access.
Both raw reference structure and resolved configuration must be examined.

## Shared invariant and authority

Desired state opts in with `database.credentialAliases: {mode: 'issuer-references'}`.
The isolated `database-credential-aliases` plan scope may emit one
`databaseCredentialAliasesRepair` action for the already-bound database. An
adapter must explicitly support this capability; unsupported providers block
without falling back to a generic environment write or password reset.

Begin with ordinary `hv_plan` for the selected environment. For a legacy binding
whose provider scope is absent, it first offers the existing `database-bindings`
repair only when the provider can independently prove the exact scope. Apply that
reviewed local-only action, then run `hv_plan` again to review alias repair.
After applying alias repair, plan again for normal deployment work. Resupply any
deployment overrides or secret references on that later plan; the isolated
metadata and alias plans never store those deployment inputs. The explicit
`scope="database-credential-aliases"` path requires already-complete bindings.
Partial, malformed or unknown scope, unavailable alias capability and pending
credential recovery block progress without unrelated mutations.

The capability observes the issuer and its dependent aliases, computes a bounded
reference-only patch, and verifies that patch by reading provider configuration.
It must preserve the canonical password, database login, database name, endpoint
and all unrelated variables. It never creates or adopts a database, runs SQL,
rotates a password, changes consumer variables, or deploys/restarts a workload.
Normal workload reconciliation and deployment remain separate actions.

`hv_status` reads the same declared invariant without persisting a plan or
repairing anything. Stale references produce drift; unavailable evidence or
pending repair recovery remains unknown and prevents an in-sync claim. Verified
reference configuration still reports SQL authentication as unchecked.

Use the durable provider resource ID with its complete account/project/environment
scope. The verified connection must authorize raw/resolved reads and the scoped
alias write. Revalidate that scope and the reviewed raw aliases and canonical
value before writing. A matching display name or hostname is insufficient identity.
Missing, sealed, unresolved, malformed, inaccessible or ambiguous inputs block;
unknown observations never mean absent aliases or a successful repair. Preserve
URI escaping and resolved non-password URL components; if the native template cannot
represent the existing credential safely, block instead of replacing it.

Completion requires a fresh raw read proving the approved reference structure,
a resolved read proving the aliases agree with the unchanged canonical value,
and the same bound issuer identity. Keep values private; return only bounded
outcomes, affected key names and actual `requestedCount`, `appliedCount` and
`skippedCount`. The receipt reports `referencesVerified`, `deploymentDeferred`
and `authentication: 'unchecked'`; no SQL session or proxy is created by repair.
A successful write acknowledgment alone is not completion. On a lost response
or delayed readback, reconcile the same action by reading before any retry; never silently
repeat the write, generate a password or switch to SQL. Concurrent issuer changes
invalidate the action. Read-before/write/read-after is not an atomic
compare-and-swap and cannot exclude a later external change.

## Provider review

“Unsupported” means this alias capability has no reviewed native implementation;
it does not mean the provider lacks database or password management. Before
admitting another provider, review its exact issuer, reference mechanism,
permissions, completion and uncertain-write recovery through real transport.

| Provider | Admission | Native identity and credential boundary | Prerequisites, completion and recovery limits |
| --- | --- | --- | --- |
| railway | Supported to implement | Bound project ID, environment ID and database service ID. Same-service `${{POSTGRES_PASSWORD}}` references can replace copied password material in `PGPASSWORD`, `DATABASE_URL`, `DATABASE_PRIVATE_URL` and `DIRECT_URL`. Independently matched user, host, port and database variables can replace copied URL components. [Reference syntax](https://docs.railway.com/variables#referencing-variables-in-the-same-service). | Read raw and resolved variables; patch only these aliases with deployment suppressed; preserve `POSTGRES_PASSWORD` and each resolved URL destination. Fresh raw/resolved readback decides convergence; uncertain responses require observation. See the scoped transport boundary below. |
| supabase | Unsupported | Exact project ref and database login, including the selected direct or pooler endpoint. Supabase connection strings require the database password; shared poolers use a different username from direct connections. [Connection methods](https://supabase.com/docs/guides/database/connecting-to-postgres). | No native alias repair is admitted. Establish the authoritative credential and every endpoint before designing delivery; direct/pooler configuration agreement and authentication are separate. A copied connection string or completed password reset is not reference-repair evidence. |
| cloudsql | Unsupported | Exact project, instance and user. `users.update` changes a user and returns an Operation. [User update API](https://docs.cloud.google.com/sql/docs/postgres/admin-api/rest/v1/users/update). | That update is an issuer mutation, outside this capability. Review password versus IAM authentication, an authoritative reference source and consumer delivery before admission; native operation completion cannot substitute for alias readback or fresh SQL authentication. |
| rds | Unsupported | Exact AWS account/region, instance and master login; when RDS manages its password, `MasterUserSecret` identifies a Secrets Manager ARN and status. [RDS-managed credentials](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-secrets-manager.html). | Review the existing credential mode, secret version, permissions and workload reference mechanism. Secret status and retrieval alone do not prove consumers use the credential. Do not enable managed passwords or rotate the secret as an alias repair; uncertain changes require native recovery. |
| neon | Unsupported | Exact project, branch and role plus its endpoint. Role password resets are branch-scoped and take effect on new connections; stored connection strings must then be updated. [Role management](https://neon.com/docs/manage/roles). | A reset changes the issuer and is outside scope. No native issuer-following alias mechanism is admitted. Review branch isolation, credential retrieval, pooled/direct delivery and uncertain-write recovery before adding support. |
| azure-postgres | Unsupported | Exact subscription/resource group/Flexible Server and administrator login. Reset requires password authentication and a ready server; primary changes propagate asynchronously to replicas. [Administrator password contract](https://learn.microsoft.com/en-us/azure/postgresql/security/security-reset-admin-password). | No alias operation is admitted. Distinguish administrator from application roles and password from Entra authentication. Native reset completion, replica propagation and workload reference readback require separate evidence; never reset the administrator merely to obtain a value for aliases. |
| digitalocean | Unsupported | Exact account, database cluster UUID and database user. User password reset can break dependent services. [Users and credentials](https://docs.digitalocean.com/products/databases/postgresql/how-to/manage-users-and-databases/). | No native alias mechanism is admitted. Review authoritative user credentials, connection-pool identities, delivery permissions, completion and recovery before implementation. A cluster/user read or reset receipt does not establish that consumer secrets follow the issuer. |
| fly | Unsupported | Exact organization, database cluster/app, login and consuming app; distinguish Managed Postgres from legacy unmanaged Postgres. Managed attachment supplies an app `DATABASE_URL` secret; pooled and direct URLs differ. [Managed connection contract](https://docs.fly.io/postgres/client-configuration). | Attachment is not evidence of an issuer-following alias and is not a repair fallback. Review the bound product's credential issuer, secret visibility, deployment effects and recovery before admission; app-secret installation does not prove SQL access or durable reference semantics. |

## Railway transport boundary

Admission covers existing aliases only and a literal canonical password. The
[recorded public PostgreSQL template](../test/provider-contracts/railway/postgres-template.recorded.json)
independently establishes composed same-service references for the user,
password, host and database. Repair preserves these definitions and verifies
their independently observed rendering. Copied URLs use `PGUSER`, `PGHOST`,
`PGPORT` and `PGDATABASE` references only when every component matches exactly;
otherwise their destination remains unchanged. Existing `DIRECT_URL` receives
the same repair and verification as the database URL aliases. A changed,
unresolved or cyclic dependency blocks mutation. URL query options are limited
to `sslmode`, `application_name` and `connect_timeout`. Whole-URL references,
foreign-service references and any `DATABASE_PUBLIC_URL` evidence block this
repair. No absent alias is created.

The regression counterexample was the recorded official template's composed
`DATABASE_URL`: the earlier parser rejected it as `unsupported_reference`, and
ignored `DIRECT_URL`. Both new real-client/serialized-transport cases failed
before the fix. They now cover a mutation-free template read, copied direct URL
repair, unchanged destinations, dependency drift, issuer updates and lost-write
readback. Provider rendering in these tests is synthetic; the public template
configuration is recorded. This does not claim live SQL access or a deployed
application's current environment.

The [variable API](https://docs.railway.com/integrations/api/manage-variables)
supports raw reads using `unrendered: true` and resolved reads without that flag.
Its collection upsert can replace the entire collection, so this repair must use
additive writes (`replace: false`) with `skipDeploys: true` and all three exact
scope IDs. The implementation must verify explicit successful acknowledgment
and subsequent readback. Sealed values cannot be retrieved through the API;
they cannot be treated as proven matches.

Railway's [Database View](https://docs.railway.com/databases/database-view#connection)
owns its supported Regenerate operation, which updates SQL authentication and
the password variable together. Editing a variable alone does not change an
initialized database's password. Alias repair deliberately leaves that canonical
value unchanged and cannot repair a disagreement between it and SQL. It must not
call Regenerate, `ALTER USER`, or a deployment operation.

The checked-in official CLI [GraphQL schema](../test/provider-contracts/railway/schema.graphql)
and [source record](../test/provider-contracts/railway/source.json) constrain
argument names, types and default flags. `EnvironmentVariables` is an opaque
scalar: schema validation does not validate individual keys, reference expansion,
atomicity, eventual consistency or running-container state. Documentation-based
transport tests must therefore separately check exact scope, raw/resolved reads,
the allowlisted patch, unchanged canonical value, no deployment and uncertain
acknowledgments. Synthetic responses must be identified as synthetic, not as
captured successful provider behavior.

Configured credential alignment is not fresh SQL authentication. Administrative
proxy access may use a different credential source from an application's URL.
Matching literal host/port/database fields also does not prove physical database
identity. Report configuration convergence, any separately performed login check,
and application rollout independently. No live repair or SQL authentication is
claimed by this document or its registry test.

The read-only comparison includes issuer `PGPASSWORD` and `DIRECT_URL` when
present and checks each bound application's present `DIRECT_URL`. For that
application alias, the comparison target is issuer `DIRECT_URL`, otherwise
`DATABASE_PRIVATE_URL`, otherwise `DATABASE_URL`. It reports the chosen key and
keeps unusable present values unknown. Absent optional aliases are not errors:
the recorded native template has neither `DIRECT_URL` nor `DATABASE_PRIVATE_URL`.
Five serialized-transport counterexamples failed before extending the previous
URL-only diagnostic; API observation and registered-command regressions now
cover these aliases and value-free output. These comparisons examine resolved
configuration only; raw reference verification belongs to the isolated alias
capability above.

The normal `npm test` gate includes
`test/provider-contracts/database-credential-aliases-contracts.test.ts`. It checks
the eight-provider review roster against the real registry, explicit admission
and official source links, plus the pinned Railway schema's limited transport
shape. It does not execute a repair or certify live permissions, reference
resolution, concurrent updates or database access.
