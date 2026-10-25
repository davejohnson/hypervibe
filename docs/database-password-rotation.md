# Database password rotation boundary

The `credentials` plan scope dispatches `kind: database-password` to a dedicated
native lifecycle. It does not send a replacement password through the generic
application-variable writer as though that changed database authentication. All
eight registered PostgreSQL providers implement native authentication and issuer
capabilities, composed with the existing hosting readers/writers in the same
reviewed two-action lifecycle. The [provider matrix](../test/provider-contracts/database-password-provider-matrix.json)
records native differences and official sources; normal `npm test` requires every
registered adapter and positive application plan/apply coverage. Actual runtime
activation and application operations retain their independent evidence.

The complete optional capability reviews the exact scoped database, role,
logical database, authoritative issuer names and all existing referenced
consumers. Existing literal connection URLs use encrypted reviewed templates that
replace only their passwords. References remain references; unknown endpoints,
unresolved references and unknown/external consumer coverage block mutation.
For explicitly observed write-only consumer keys, the declared database binding
and alias mapping supply the reviewed replacement. Acknowledged synchronization
does not claim to read their current values; failed reads never grant write authority.
Provider-generated replacements are recovered through exact-user reads and frozen
before consumer writes. Configuring this declaration does
not grant direct provider or SQL access outside Hypervibe.

A declaration uses an existing secret role with `kind: database-password`, a
private `source` reference or the existing Hypervibe generator, and
`database: { environment, component, username, database }`. Its `environments` array is empty: the password input is for the
native database destination, not a raw variable injected into every workload.
Review uses `hv_plan scope="credentials" credential=<role> intent="rotate"`,
then exact action IDs through `hv_apply`. `intent="adopt"` verifies and records
existing values without resetting credentials or synchronizing different values.
Fly, DigitalOcean and RDS-managed master credentials retain provider-generated
ownership and recover the exact current replacement after an uncertain response.
No production
rotation was performed or authorized by this implementation work.

## Authority and recovery

The plan contains two explicit, confirmed, data-bearing database actions:

1. Change the actual database credential, then establish fresh authentication to
   the intended role and database using the same frozen replacement.
2. Synchronize only the reviewed database issuer/reference names, depending on
   the first action's authentication proof, and verify their readback.

Only the existing bound database and reviewed hosting consumer keys may be
mutated by these actions. Fresh authentication reuses the provider's existing
temporary access/connector lease and cleanup contract, explicitly described in
the review. No data alteration, schema migration or session termination is
implied. Hosting adapters retain their declared configuration activation effects;
the normal rollout lifecycle retains exact
workload requirements, including declared `databaseEnvAliases`, even when their
raw reference strings do not change. Every configured consumer must have one
independently observed provider identity in the exact hosting scope. Strict
activation requires matching resolved deployment configuration or accepted
selected-key writes joined to exact native/managed replacement deployments.
Per-consumer deployment IDs and native configuration versions remain in the
encrypted recovery record. Old active deployments stay pending, and providers
that only observe routing or revisions do not establish individual process
retirement. A successful deployment status alone is insufficient.

The source is resolved once and frozen in encrypted plan storage. Private
configuration expectations and the original deployment baseline are encrypted.
Database recovery markers are in encrypted component bindings. An attempted
write is persisted and independently re-read with the exact component identity before crossing its mutation boundary. Null or misleading repository acknowledgements cannot authorize provider mutation. On retry, fresh SQL
proof and configuration readback reconcile the same replacement. A lost response
never generates another password or blindly repeats an uncertain write. Each
consumer's attempted update is encrypted before mutation; readback recovers a
committed write and retry finishes only consumers not yet attempted. A write-only
destination with an ambiguous response requires the returned explicit
`<configuration-action-id>:retry-uncertain` confirmation before resending the same
replacement; it never resets the database again. Unknown
authentication cannot authorize a first reset.
Uncertain native recovery blocks unrelated plans and applies. Malformed recovery
markers remain blockers. Successful issuer installation releases the mutation
blocker while retaining pending rollout obligations and explicit unchecked
application/session evidence.

Local `hv_destroy` also preserves database/alias recovery, pending generic
credential updates and strict activation records. Local deletion has no live
provider evidence proving those records safe to discard; a verified transfer or
retirement workflow remains required. Legacy generic database-secret plans are
blocked from replay, preserving their encrypted input and progress for review.
They cannot bypass the dedicated capability/authority boundary.

## Independent evidence and limits

The challenged assumption is that a native reset helper or a matching variable
value is sufficient to safely finish database rotation. A counterexample is a
successful SQL password change with a lost acknowledgement while issuer
configuration and running workloads still use the old value. Another is valid
references and matching current configuration with a stale deployed consumer.

[Railway's rotation guidance](https://blog.railway.com/p/security-disclosure-recommendation-rotate-postgresql-database-credentials)
separates the PostgreSQL password update, issuer variables, consumer redeploys
and existing connections. The [official PostgreSQL image documentation](https://github.com/docker-library/docs/blob/master/postgres/README.md)
limits initialization variables to an empty data directory: changing
`POSTGRES_PASSWORD` on an initialized container is not SQL password rotation.
[PostgreSQL ALTER ROLE](https://www.postgresql.org/docs/current/sql-alterrole.html)
changes authentication at the SQL boundary. A native administrative probe still
does not validate an application's actual URL, TLS configuration, pooler,
network path or operation.

The all-provider application regressions first failed at the former blanket
native-lifecycle rejection, before composition was added. Passing tests now cover
exact confirmation/dependencies, frozen replacement recovery after lost SQL and
issuer acknowledgements, unknown authentication, aliases, scope mismatch,
SQL-only capability rejection, provider-generated value-preserving adoption,
partial consumer recovery and retained activation requirements. Additional
regressions were observed failing for wrong hosting provider/project/environment,
malformed installed recovery, non-durable intent persistence and destructive local record deletion; they pass
after scope/preservation enforcement. These exercise real planning, apply and
SQLite encryption, but do not establish any provider's live SQL compatibility.
Disposable real PostgreSQL authentication and deployed-configuration regressions
are described in [database authentication](database-authentication.md).
No customer incident cause, live credential rotation, private routing or
application operation is proven by these checks.

The committed acceptance workflow runs `npm test` and `npm run typecheck` and
the desired required check is `Hypervibe / acceptance`. Live branch-protection
enforcement was not verified. Provider permissions, real network access and
application behavior are verified by the user's reviewed apply, authentication
and managed rollout evidence; offline contracts do not claim a live rotation.
