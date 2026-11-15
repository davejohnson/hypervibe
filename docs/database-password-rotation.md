# Database password rotation

The `credentials` plan scope dispatches `kind: database-password` to a dedicated
native lifecycle, composed with the existing hosting readers, writers and managed
rollout. Updating a variable is not SQL password rotation. The
[provider matrix](../test/provider-contracts/database-password-provider-matrix.json)
records registered capabilities and official sources; implementation and offline
tests do not establish live cloud or application compatibility.

## Declaration and review

Use an existing secret role with `kind: database-password`, a private `source`
reference or the existing Hypervibe generator, and
`database: { environment, component, username, database }`. Its `environments`
array is empty: this input targets the database, not every workload's environment.
Use `hv_spec` → `hv_plan scope="credentials" credential=<role> intent="rotate"`
→ exact action confirmation through `hv_apply`. `intent="adopt"` verifies and
records existing values without resetting credentials or synchronizing different
values. The declaration grants no direct SQL or provider access outside Hypervibe.

A delegated supplied-mode role may use positive `rotationGeneration` instead of
`source`. The private root key and exact project/environment/component/role/generation
derive one stable replacement for repeated review. Increase the generation after
acceptance; it does not authorize replaying a write. Provider-generated passwords
are a separate reviewed input mode: recover the exact user's replacement and
freeze it before consumer writes. RDS-managed master secrets retain provider ownership.

The plan reviews the exact scoped database, role, logical database, issuer names
and every existing consumer. Literal URLs use encrypted templates that replace
only passwords; references remain references. Unknown endpoints, unresolved
references or unknown/external consumer coverage block mutation. Explicitly
observed write-only keys use the declared database binding and alias mapping;
accepted synchronization does not claim current-value equality. Failed reads
never grant write authority.

## Authority and recovery

The native plan has two explicit, confirmed, data-bearing actions:

1. Change the actual database credential and establish fresh authentication to
   the intended role and database using the same frozen replacement.
2. Synchronize only reviewed issuer/reference names after that authentication
   proof, then verify readback.

Same-user rotation invalidates the previous password for new connections as soon
as the database accepts it; existing sessions may remain open. Review that
disruption before mutation. This is not an overlapping two-credential rotation.
No data alteration, schema migration or session termination is implied.

Only the bound database and reviewed hosting consumer keys may change. Fresh
authentication uses existing access or the provider's supported temporary access
lease and cleanup contract, explicitly described in the review. Railway never
creates public access to proceed; an unreachable private database remains
unverified. Unknown authentication cannot authorize a first reset.

The replacement, comparison expectations, original deployment baseline and
component recovery markers remain encrypted. Persist and independently re-read
intent with the exact component identity before each provider mutation; a null or
misleading persistence acknowledgment grants no authority. Retry reconciles the
same replacement through fresh SQL proof and configuration readback. A lost
response never generates another password or blindly repeats an uncertain write.
Each consumer's attempt is durable before mutation; readback recovers a committed
write. An ambiguous write-only update needs the returned exact
`<configuration-action-id>:retry-uncertain` confirmation to resend the same
replacement, without resetting the database again.

Uncertain native recovery blocks unrelated plans and applies; malformed recovery
markers remain blockers. Successful issuer installation releases that mutation
blocker while retaining rollout obligations and unchecked application/session
evidence. Local `hv_destroy` preserves database/alias recovery, pending generic
credential updates and strict activation records until verified transfer or
retirement. Legacy generic database-secret plans cannot replay around this boundary;
their encrypted inputs and progress remain available for review.

## Provider-specific boundaries

| Provider | Authentication and recovery |
| --- | --- |
| Railway | Bound project, environment, service, SQL user and database. `ALTER ROLE` changes authentication; additive `POSTGRES_PASSWORD` synchronization uses `skipDeploys: true`. Copied aliases first require the separate [reference repair](database-credential-aliases.md); authored references remain intact. Fresh authentication recovers uncertain SQL, and exact issuer readback recovers metadata. |
| Cloud SQL | `users.update` sends only the exact user's name and frozen password. Completion must correlate the returned operation with the bound project/instance; it remains separate from fresh SQL authentication. |
| Amazon RDS | `ModifyDBInstance` changes the bound master password; a separately bound non-master role uses its own SQL session. Unrelated pending modifications block `ApplyImmediately`. Managed masters use `RotateMasterUserPassword` with generated-reset SDK retries disabled and recover through the exact Secrets Manager ARN. |
| Azure PostgreSQL | Flexible Server `PATCH` changes only `administratorLoginPassword`, using existing ARM operation handling. A separately bound non-admin role uses its own SQL session. Exact subscription/resource group/server, role and database remain required. |

Railway's authored password references require URI-unreserved characters; its
base64url generator satisfies that constraint. Reject incompatible replacements
before changing authentication. Railway's SQL path sends a salted SCRAM-SHA-256
verifier instead of the plaintext replacement, independent of the role's password
storage default. A verifier may still appear in private server logs and must
never appear in Hypervibe's public results or persisted output. Other providers'
SQL fallback parameter logging remains a separate gap. See PostgreSQL's
[pre-encrypted password handling](https://www.postgresql.org/docs/17/sql-createrole.html)
and [parameter logging](https://www.postgresql.org/docs/17/runtime-config-logging.html).

## Authentication, deployment and operation evidence

Raw references, resolved configuration, selected deployment configuration, fresh
authentication and application operation are separate evidence. An unchanged
reference can resolve to a new password while the running deployment remains
stale. A snapshot describes provider configuration, not every process's environment.
Changing `POSTGRES_PASSWORD` on an initialized database does not change its SQL
password; the [official image contract](https://github.com/docker-library/docs/blob/master/postgres/README.md)
limits initialization variables to an empty data directory.

Native probes require a real password challenge and the intended session user and
database. Trust, peer or certificate-only authentication remains unknown even if
the session succeeds. PostgreSQL's
[SQLSTATE table](https://www.postgresql.org/docs/current/errcodes-appendix.html)
defines `28P01` as invalid password; routing, TLS and timeout failures remain
unknown. Database names and schemas are distinct; `public` is not a database name.
The internal probe needs no standalone public command. Separately authorized
`hv_db_query` diagnostics may establish the selected session's identity; their
managed connection can require temporary access approval and observed cleanup.
They do not prove the application's connection configuration or SQL compatibility.

`hv_plan` and `hv_status` compare declared consumers, including
`databaseEnvAliases` and replica URL keys, with exact selected deployments without
adopting resources or writing baselines. Rollout retains the original operation,
scope, service identity and encrypted expectations. Require matching resolved
configuration or accepted selected-key writes joined to exact native/managed
replacement deployments, plus complete active deployment coverage. One consumer's
receipt cannot discharge another's requirement. Missing snapshots, partial scope
and insufficient retirement evidence stay unknown or pending; deployment success
alone cannot finish rotation. Traffic-only coverage currently limits Cloud Run
services and ECS Express. See [runtime provider evidence](runtime-credential-providers.md#database-consumer-activation-evidence)
for native activation and retirement boundaries. Application business operations
still require their own verification.

## Optional deployed application authentication

Supplied-mode rotation can opt into `database.applicationDriver: "node-postgres"`.
This adds a third read-only action after native authentication and issuer update.
Reapply the same plan after normal rollout proves exact consumer activation and
old deployment retirement. The action uses every running replica's unchanged
runtime URLs and installed `pg` driver, requiring a password challenge and matching
session user/database. Removing the action or changing private references
invalidates the encrypted review. Existing two-action plans, adoption and
provider-generated recovery keep their existing authority.

This capability is Railway-only and validated offline. `sshIdentityFile` and
`sshKnownHostsFile` must identify an already registered key and independently
trusted host file. Native SSH uses strict host checking; it registers no keys,
accepts no new hosts, invokes no Railway CLI and creates no network access.
Missing access or idle/unknown replicas block the opt-in before SQL mutation;
the native SQL route must already be reachable. Idle cron workloads, custom driver
connection options and non-Node applications have no deployed-driver verifier.
Other database providers reject this opt-in while retaining native rotation.

The [pinned Railway SSH implementation](https://github.com/railwayapp/cli/blob/v5.27.0/src/commands/ssh/native.rs)
selects exact deployment-instance usernames. A raw snapshot reference remains
unknown unless existing trusted runtime access covers every exact instance before
and after the read. All discovered alias names travel from encrypted expectations
into observation; values and comparison hashes do not.

## Verification limits

Ordinary `npm test` includes application plan/apply and encrypted-recovery checks,
real-client provider transport contracts, synthetic PostgreSQL wire tests, and a
disposable real PostgreSQL suite. The latter requires local PostgreSQL binaries
and fails rather than silently skipping when unavailable. It distinguishes
metadata edits from actual password changes and fresh connections from existing
sessions. Logging and password-challenge checks cover SCRAM and trust behavior.
Synthetic transport responses and local database tests do not establish cloud
permissions, live routing, deployed application operation or an incident's cause.
The acceptance workflow runs this suite and type checking; repository configuration
alone does not establish live branch-protection enforcement.
