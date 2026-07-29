# Provider conformance

Hypervibe provider support is a lifecycle contract, not a provider name in a
schema. Every supported provider must pass the same resource contract through
the normal desired-state loop.

Catalog and blueprint work is intentionally separate from this contract.

## Contract families

Hosting, databases, and caches have separate contracts:

- Hosting: project/environment identity, service identity, configuration,
  environment-variable drift, deploy/source state, observation, deletion, and
  terminal absence.
- PostgreSQL: provision, observe, wire runtime variables, connect with a
  bounded operation, noop, replace/migrate, destroy, retry, and terminal
  absence.
- MongoDB: provision, observe, wire `MONGODB_URI`, verify a bounded database
  operation, noop, destroy, retry, and terminal absence. PostgreSQL migration
  and SQL-query commands must reject MongoDB clearly.
- Redis: provision, observe, wire `REDIS_URL`, verify a bounded `SET`/`GET`,
  noop, destroy, retry, and terminal absence. SQL migrations and database reset
  do not apply.

The requested matrix lives in
`test/provider-conformance/provider-matrix.ts`. A provider moves from `planned`
to `ready-for-live` after its registry, schema, adapter, connection guidance,
and mocked contract are green. The opt-in live runner accepts
`ready-for-live`, but the roadmap remains red and Hypervibe does not advertise
support. Only a green live contract promotes it to `supported`.

The ordinary `npm test` suite stays green for supported behavior. Run
`npm run test:providers:roadmap` separately to execute one intentionally red
acceptance test per provider/resource contract. Each failure reports whether
the provider is registered, exposes the requested lifecycle and engine,
accepts the matrix credential shape, and has been promoted to `supported`.
Those failures are the implementation queue; they must not be added to the
ordinary CI gate until the corresponding provider is fully supported.

AWS hosting targets ECS on Fargate rather than App Runner because the
[AWS App Runner API documentation](https://docs.aws.amazon.com/apprunner/latest/api/API_ListServices.html)
says App Runner is unavailable to new customers after March 31, 2026. The
requested database matrix uses RDS independently of that hosting choice.

Redis/Valkey starts with Railway, Memorystore, DigitalOcean, ElastiCache,
Render, Upstash, and Azure Managed Redis. Railway is the first implemented
adapter slice. It is `ready-for-live`, not `supported`, until the opt-in live
teardown contract passes.

Neon is the first newly implemented database slice. Its registry, credential
schema, provider adapter, connection guidance, and mocked create/observe/destroy
contract are green. It is `ready-for-live`, not `supported`, until the opt-in
live contract proves create, noop, and terminal teardown against an isolated
Neon account.

DigitalOcean is the first combined hosting/database/cache slice. One registered
deployment provider exposes App Platform directly and derives Managed
PostgreSQL and Managed Valkey adapters through the provider registry. Its mocked
contracts pin complete pagination, durable-ID-first observation, duplicate-name
blocking, partial-create identity preservation, secret-safe receipts, and
provider-confirmed terminal deletion. New Redis-compatible clusters use
DigitalOcean's current `valkey` engine; observation also recognizes legacy
`redis` clusters.

All three DigitalOcean entries remain `planned` despite those green unit
contracts. Hypervibe now generates a provider-owned GitHub Actions workflow
that publishes one DOCR image tagged with the exact checked-out Git SHA,
updates only already-bound App Platform components, waits for that exact
deployment ID to become `ACTIVE`, and verifies the active component image.
It never creates a container registry, app, or component from CI. A verified
connection must name an existing registry with `containerRegistry`, supplied to
the live runner as `HYPERVIBE_TEST_DIGITALOCEAN_REGISTRY`.

The remaining promotion gate is a live harness that can execute the managed
GitHub workflow (the current temporary local fixture cannot), followed by a
successful opt-in stack run proving that App Platform can create the app shell,
deploy the fixture, converge to noop, and tear down the app, PostgreSQL cluster,
and Valkey cluster through spec/plan/apply.

The extended matrix also includes:

- [Azure Container Apps](https://learn.microsoft.com/en-us/rest/api/resource-manager/containerapps/container-apps)
  for hosting, [Azure Database for PostgreSQL Flexible Server](https://learn.microsoft.com/en-us/rest/api/postgresql/)
  for PostgreSQL, and [Azure Managed Redis](https://learn.microsoft.com/en-us/azure/redis/overview)
  for Redis. They are separate provider ids because they have independent
  resource types, durable identities, observation, and deletion lifecycles,
  while sharing one Azure credential shape.
- [Fly Machines](https://fly.io/docs/machines/api/) for hosting. Fly Managed
  Postgres is also represented as a planned PostgreSQL target, but its promotion
  is gated on a documented, supported provider lifecycle API. The current
  [public lifecycle guide](https://fly.io/docs/mpg/create-and-connect/)
  documents dashboard and `fly mpg` flows; Hypervibe must not depend on
  `flyctl` or an undocumented endpoint.
- [Vercel Projects and Deployments](https://vercel.com/docs/rest-api) for
  hosting. Vercel is intentionally absent from the database matrix because
  [Vercel Postgres is no longer available](https://vercel.com/docs/postgres);
  its current Postgres offerings are provider-owned Marketplace integrations.
- [Neon Postgres](https://api-docs.neon.tech/reference/use-cases) as its own
  database provider. Neon owns the project, branch, endpoint, database, and
  deletion lifecycle even when a Vercel integration wires it to an app. Its
  adapter uses the public Neon API directly and does not depend on a provider
  CLI.

These entries are test-first targets, not current support promises. An entry
stays `planned` until its provider adapter and mocked lifecycle contract pass,
then remains `ready-for-live` until its complete live lifecycle contract passes.

## Required lifecycle phases

Every live provider contract must prove:

1. A verified connection is available through a local credential reference.
2. A ProjectSpec plans provider-confirmed creates; unknown observation never
   authorizes a create.
3. Apply mutates only the exact actions in the persisted plan.
4. Live observation returns durable provider identities.
5. Replanning unchanged desired state produces only noops and causes zero
   provider mutations.
6. A configuration change updates the existing resource rather than creating a
   duplicate.
7. Removing desired resources plans dependency-ordered, exact-action-confirmed
   deletion.
8. Apply waits for provider-terminal absence before removing local bindings.
9. Repeating deletion after interruption or provider-side absence converges
   safely.
10. No credentials, connection URLs, passwords, or secret values appear in
    plans, receipts, logs, snapshots, or test failures.

An environment-level desired-absent state is required for complete cleanup.
Test cleanup must not call provider APIs directly, because that would bypass
the lifecycle behavior the test is intended to prove.

## Running an opt-in live test

Live tests are skipped during ordinary `npm test`. They are billable and
destructive and must use an isolated provider account/project intended for
testing.

Build first, export only the credential variables named by the provider matrix,
then select exactly one contract:

```sh
HYPERVIBE_LIVE_HOSTING=railway npm run test:providers:live
HYPERVIBE_LIVE_DATABASE=cloudsql npm run test:providers:live
HYPERVIBE_LIVE_DATABASE=neon npm run test:providers:live
```

`HYPERVIBE_LIVE_CACHE=<provider>` becomes available when a cache entry reaches
`ready-for-live`. The runner refuses `planned` entries before reading
credentials or creating billable resources.

The Neon contract requires `HYPERVIBE_TEST_NEON_API_KEY` plus the Railway
fixture-host credentials. Set `HYPERVIBE_TEST_NEON_ORGANIZATION_ID` when a
personal Neon key should target an organization, and optionally set
`HYPERVIBE_TEST_NEON_REGION_ID`. Use only an isolated account/workspace because
the contract creates and destroys real provider resources.

The runner copies a tiny HTTP fixture into a temporary worktree and writes a
mode-`0600` temporary credential object. Hypervibe consumes it through
`credentialsRef=file:...`; the file is deleted immediately after connection
verification. Values are never passed as CLI arguments or printed. The test
removes its services, databases, and caches through spec/plan/apply, and its
`afterAll` repeats that desired-state cleanup after a partial test failure.

Until the environment desired-absent lifecycle is implemented, the final live
provider-context/local-binding assertion remains a test-first `todo`. A live
run may therefore leave an empty provider project/environment context, but it
must not leave a workload, database, or cache. Use only an isolated provider
account/project intended for testing. Do not enable a provider in shared CI
until the final assertion is executable and cleanup failures surface the
remaining provider resource identities.
