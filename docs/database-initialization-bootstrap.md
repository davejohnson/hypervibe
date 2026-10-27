# Fresh database authentication and schema bootstrap

A completed persistence repair does not prove that PostgreSQL accepts an
application connection or that its schema exists. This lifecycle admits a
separate bootstrap task only for the exact database generation recorded by a
completed `freshInitialization` receipt. It runs through spec, plan and apply;
there is no standalone SQL-verification or migration command.

The optional `database.freshInitialization.bootstrap: { service, image }`
declaration selects the existing canonical release command, for example the
application's reviewed `npm run migrate`. Sample-data seeding remains separate.
Its plan freezes the database generation and
native scope, source service, immutable configured application image, selected
database references and command. Reviewing that image does not certify a
successful release or prove its source commit. Ordinary seed and named-task
release requirements remain unchanged.

## Separate evidence and authority

| Evidence | What it establishes |
| --- | --- |
| Completed fresh initialization | Exact persistence and database configuration activation; SQL and application schema remain unchecked. |
| Private authentication task | The task's intended database, login and supported connection configuration passed a fresh password-authenticated PostgreSQL connection. |
| Reviewed bootstrap task | That exact command exited successfully in that exact image after authentication; this is not an independent schema-correctness audit. |
| Verified task cleanup | The exact temporary execution resource is absent; an attempted delete is insufficient. |
| Subsequent backup and application verification | Separate recovery, workload activation, drainage and operation evidence; bootstrap success supplies none of these claims. |

The bootstrap plan requires exact action confirmation. Only its proven fresh
generation can avoid the old-source backup prerequisite. It cannot waive
future backup and restore requirements or authorize app rollout. A historical
seed receipt for the same service and command does not initialize a replacement
data generation. Stale, changed, missing or consumed initialization evidence
cannot reopen the task.

Authentication and migration are separate plans and confirmations. The migration
also repeats authentication immediately before executing the exact reviewed
command. The selected immutable image is reviewed as that configured artifact;
this path does not infer a source commit or promote a failed application release.

Provider mutations are journaled before they are attempted and acknowledged
identities are retained immediately. Resume observes that exact execution.
Unknown creation without an acknowledged identity blocks replay; a matching
name is not adoption authority. An uncertain migration outcome likewise cannot
be rerun automatically. A terminal result is retained before cleanup so cleanup
can resume without repeating database writes.

An acknowledged deployment remains observable and its owned task remains
cleanable after application configuration changes. This recovery takes priority
over new reference repairs. It cannot create or redeploy a task, and current
database evidence must still match before authentication or bootstrap completion
is recorded. A consumed generation never reruns bootstrap; later ordinary
migration commands and deployment changes continue through their normal gates.

Only approved provider-resolved database references reach the temporary task.
The fixed authentication program uses the application image's PostgreSQL client
and supported connection configuration. The reviewed image must contain Node.js,
the `pg` package and `/bin/sh`; this implementation does not provide a verifier
for other application runtimes. Unsupported overrides block admission.
It requires a password challenge: a local `trust` connection cannot prove a
password. Migration stdout, stderr and raw provider errors are not returned;
results use finite correlated outcomes. Credential values and private comparison
inputs never become plaintext plans, repository bindings or diagnostics.

## Provider admission

The [provider matrix](../test/provider-contracts/database-initialization-bootstrap-provider-matrix.json)
reviews every registered hosting and PostgreSQL provider against official
sources. Native job availability and database connectivity are prerequisites,
not proof that this lifecycle is implemented.

| Hosting | Admitted PostgreSQL providers | Implementation boundary |
| --- | --- | --- |
| Railway | Railway | Private temporary workload, selected raw references, immutable image and retained exact storage/execution identities. Ready for live validation, not live-verified. |
| Cloud Run, ECS, Azure Container Apps, Fly, DigitalOcean, Vercel | None | Explicitly unsupported for this lifecycle. |

Supabase, Neon, Cloud SQL, RDS, Azure PostgreSQL, Fly MPG and DigitalOcean
PostgreSQL are also unsupported bootstrap targets. Their native database
identity, connection and recovery semantics remain distinct. In particular,
Supabase and Neon recommend direct migration connections; generic pooled login
success does not establish migration compatibility. The matrix records these
differences and the prerequisites for each provider without inventing adapters.

## Evidence limits and CI

The [roster check](../test/provider-contracts/database-initialization-bootstrap-provider-contracts.test.ts)
requires complete named-provider coverage and exact registered pair admission.
It runs under ordinary `npm test`, which is present in both the committed
acceptance workflow and desired acceptance configuration. This does not certify
live branch-protection settings.

The matrix is an official-source design review, not a captured provider response
or a live acceptance result. Pinned Railway transport tests and disposable real
PostgreSQL program tests must separately establish request compatibility,
authentication behavior and retry safeguards. Neither those offline checks nor
task success proves the cause of a customer incident. Live permissions, image
pulling, private routing, application behavior and production recovery remain
separate verification work.
