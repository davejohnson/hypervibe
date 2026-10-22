# Database password rotation contract

Reviewed 2026-10-21. This is a single-password replacement contract, not
zero-downtime rotation or proof that a whole project is contained. Replacement
invalidates new logins with the previous password before consumers are updated.
Established sessions, poolers, replicas and outside consumers require separate
review. A monthly trigger does not waive these prerequisites or authorize a
provider write independently of a persisted plan.

The shared database adapter capability identifies one bound database and login,
performs at most one native issuer update, and tests fresh password authentication
without returning values. An adapter acknowledgment is not authentication proof.
The controller must retain the previous and candidate material in encrypted
recovery state before attempting the update, revalidate the exact target and
consumer plan, require consequential confirmation, then reconcile ambiguous
outcomes by testing the same candidate. It must never automatically generate
another replacement or repeat the password update after an uncertain outcome.

Before replacement, the old password must authenticate and the candidate must
receive PostgreSQL's specific invalid-password response. This establishes that
the selected endpoint actually checks passwords. After replacement, fresh new
authentication must succeed and fresh old authentication must be rejected.
Permission, network, TLS, timeout and malformed identity results remain unknown.
This does not terminate previously authenticated sessions.

| Registered database | Native identity and operation | Implementation and limits |
| --- | --- | --- |
| supabase | Exact project ref, organization and region; PATCH `/v1/projects/{ref}/database/password`. Its 200 response contains only a message, not a password, operation ID or consumer proof. [Management API](https://supabase.com/docs/reference/api/v1-update-database-password) | Native replacement adapter and fresh direct PostgreSQL authentication checks are implemented offline. Only the provider's default `postgres` login/database is admitted. Each bound dedicated PgBouncer or shared Supavisor endpoint must match native configuration and pass its own fresh authentication checks. Mixed direct/pooler results remain unknown. Established sessions and consumer rollout remain separate. No live rotation is claimed. |
| railway | Native database-view Regenerate updates PostgreSQL authentication and `POSTGRES_PASSWORD` together. [Database view](https://docs.railway.com/databases/database-view) | Unsupported by this capability: the checked-in official CLI SDL does not expose a password-regeneration mutation. Variable upsert alone does not rotate an initialized PostgreSQL instance; independent ALTER USER alone does not synchronize provider variables. No undocumented API is invoked. |
| cloudsql | Exact project, instance and user; PUT users.update returns an Operation. [Update](https://docs.cloud.google.com/sql/docs/postgres/admin-api/rest/v1/users/update) | Unsupported pending correlated operation completion, exact login selection, private access and authentication-proof implementation. Shared User dual-password fields do not establish PostgreSQL overlap. |
| rds | Exact instance identifier/account/region and master login; ModifyDBInstance MasterUserPassword. [API](https://docs.aws.amazon.com/AmazonRDS/latest/APIReference/API_ModifyDBInstance.html) | Unsupported pending asynchronous completion, IAM-managed-secret mode and auth proof. ApplyImmediately can apply unrelated pending modifications and must not be used as a generic rotation flag. Reset may restore master permissions. |
| neon | Branch-scoped role reset. [Roles](https://neon.com/docs/manage/roles) | Unsupported; branch and pooler evidence plus every consumer must be accounted for. |
| azure-postgres | Flexible Server administrator password update. [Server management](https://learn.microsoft.com/en-us/azure/postgresql/configure-maintain/how-to-manage-server-cli) | Unsupported; admin and application roles differ; completion, private routing and fresh auth need implementation. |
| digitalocean | Exact cluster/user password reset. [Users](https://docs.digitalocean.com/products/databases/postgresql/how-to/manage-users-and-databases/) | Unsupported; native reset completion, exact credentials and old/new auth proof remain unimplemented. |
| fly | Managed versus self-hosted PostgreSQL require different operations. [Managed PostgreSQL](https://fly.io/docs/mpg/) | Unsupported; the exact bound service's credential lifecycle remains unreviewed. |

The ordinary CI suite pins this eight-provider roster, exercises real Supabase
HTTP serialization against selected operations from the existing pinned official
OpenAPI revision, and tests fresh authentication against isolated local PostgreSQL.
It does not establish live provider permissions, routing, pooler propagation or
application use. Runtime/CI projection and verified rollout must be authorized
separately; updating `DATABASE_PASSWORD`, a URL or local bindings alone is not a
completed rotation. PostgreSQL documents the difference between role passwords
and login sessions in [ALTER ROLE](https://www.postgresql.org/docs/current/sql-alterrole.html).

The Supabase contract extraction uses the same pinned official source revision
as the existing provider tests (`26585dd4a4d6db8910a595214c9f6e8fdd206768`), with
project GET, password PATCH, PgBouncer GET and Supavisor GET selected verbatim.
Neither upstream schema revision nor existing fixture was changed. HTTP tests
intercept transport only and exercise serialized requests, native scope,
missing/malformed acknowledgments, denied requests and lost responses. They
return acknowledgement only, never a fabricated successful authentication.

The local PostgreSQL regression verifies real SCRAM authentication over trusted
TLS before and after a role-password change and demonstrates that an established
old session still works. A TLS transport test also checks that verification sends
no session-level timeout setting to a transaction pooler; the bounded timeout is
client-side, following [Supabase's timeout limits](https://supabase.com/docs/guides/database/postgres/timeouts).
Inherited `PGOPTIONS` and replication startup settings block verification rather
than changing the reviewed login. These counterexamples were observed failing
before the relevant implementation changes and passing afterward.

The scoped lifecycle tests separately challenge the assumption that saved
installation state proves current credentials. They reproduce issuer changes
after a saved noop plan, an earlier consumer drifting during the final write,
and inconsistent consumer authority in a persisted plan. Those cases failed
before the guards were added. Apply now rechecks the issuer and every consumer;
blocked assessments cannot become successful empty applies, and unresolved
rotation prevents ordinary rollout or maintenance exit.

Maintenance evidence is obtained through the real shared observation path,
including when only hosting resources are being inspected. Recovery may use the
encrypted candidate for a read-only database-fence check only after exact issuer
identity and fresh candidate authentication succeed. It does not overwrite the
active binding during planning. A lost reset response is reconciled against that
same candidate rather than issuing another password. These tests verify local
orchestration and provider contracts; no live hosted rotation was performed.
