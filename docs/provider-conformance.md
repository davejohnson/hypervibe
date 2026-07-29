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

Render is the second combined hosting/database/cache slice. One registered
deployment provider binds an existing Render workspace, creates image-backed
web/private/worker/cron services, and derives Render Postgres and Render Key
Value adapters. The workspace is a shared provider context, not a resource
Hypervibe owns or deletes. A verified connection must include `apiKey` and
`ownerId`; managed exact-SHA hosting also requires the durable ID of an
existing GitHub Container Registry credential as `registryCredentialId`.
Hypervibe verifies that credential but never creates, rotates, or deletes it
from a service or CI action.

All three Render entries remain `planned`. Their mocked contracts pin
durable-ID-first observation, complete cursor pagination, unbound-name
adoption blocking, secret-safe connection handling, partial-create identity,
and provider-confirmed terminal deletion. Service creates are marked billable
and exact-action confirmation-gated because Render workers, cron jobs, private
services, and the default service plan can incur charges.

The generated Render GitHub Actions workflow publishes one `linux/amd64` GHCR
image tagged with the full checked-out Git SHA. It targets only already-bound
Render service IDs. New services use the public
`docker.io/library/alpine:3.20` image only as a provider-valid bootstrap (no
application code is deployed). The first managed workflow changes that
already-bound service to the exact-SHA GHCR image with the verified registry
credential; later workflows trigger exact-image deploys without changing the
repository identity. Both paths wait for the exact provider deploy ID to
become `live` and verify the provider-reported image reference. CI never
creates a workspace, service, registry credential, database, or Key Value
instance.

Render promotion requires a live harness that can run that managed workflow,
then prove create/deploy/noop/update/terminal teardown for the service,
Postgres, and Key Value resources. The current local fixture cannot publish
and execute the managed workflow, so mocked green tests do not justify
`ready-for-live` or `supported`.

Heroku is the next hosting-only adapter slice. The provider context is the
verified Heroku account, which Hypervibe binds but never creates or deletes.
Each Hypervibe web or worker service owns one container-stack Heroku app so
config-var and process lifecycles remain action-scoped. Apply creates only an
empty, deterministically named app and records its durable app UUID; existing
name matches require explicit `hv_import`, stale UUID bindings block, and
teardown waits for provider-confirmed `404` absence. Add-ons, Scheduler jobs,
pipelines, and dashboard GitHub integrations are outside this adapter.

Heroku remains `planned`. Its mocked contracts pin complete Platform API range
pagination, durable-ID-first observation, unknown-error preservation,
secret-safe config handling, partial-create identity, billable confirmation,
and idempotent terminal deletion. The generated managed workflow builds the
full checked-out Git SHA for `linux/amd64`, pushes the resulting image to only
the already-bound app/process registry paths, releases the exact Docker image
ID through Heroku's container-release Platform API, waits for the new release
to succeed, verifies its SHA/image markers and formation, and checks configured
web health paths. CI never creates an app, add-on, database, or pipeline.

Promotion requires an isolated live account and a harness that can execute the
managed GitHub workflow, then prove create/release/noop/update/terminal teardown.
The default Basic dyno becomes billable when the workflow scales the process to
one, so the live run must preserve exact-action confirmation and surface cleanup
failures with the remaining app UUID.

AWS ECS on Fargate is the next hosting-only adapter slice. The AWS account,
existing private ECR repository, VPC subnets, security groups, IAM execution
and optional task roles, and optional Application Load Balancer target group
are externally owned. Hypervibe owns one ECS cluster per Hypervibe environment,
one ECS service per web or worker workload, and that service's task-definition
revisions. Cron workloads stay outside this adapter. Public web services require
an existing `ip` target group in the same VPC, routed by an HTTP or HTTPS
listener on one active internet-facing Application Load Balancer. An explicit
`publicUrl` pins the externally routed origin for host/path rules and HTTPS-only
listeners; without it, Hypervibe accepts only a default HTTP route whose bare
ALB hostname can be health-checked safely.

AWS ECS remains `planned`. Its mocked contracts pin complete token pagination,
long-form durable ARN validation, provider-confirmed `MISSING` semantics,
unknown-error preservation, duplicate and unbound identity blocking, partial
create identity, immutable task-definition configuration, billable
confirmation, dependency-ordered terminal deletion, and safe task-definition
cleanup. Apply creates a zero-task ECS service using a public Alpine bootstrap
task definition, so it does not deploy application code or start billable
Fargate tasks before the reviewed CI action.

The generated workflow builds one `linux/amd64` image tagged with the full
checked-out Git SHA, pushes it to the existing ECR repository, and deploys the
ECR-reported digest only to already-bound long-form ECS service ARNs. It
registers a release-only task-definition revision, scales that exact service to
one task, waits for the exact rollout, verifies the running task image digest
and SHA marker, and checks configured public web health paths. CI never creates
an ECS cluster or service, task role, ECR repository, VPC resource, load
balancer, listener rule, or target group, and it does not depend on the AWS CLI.

The connection uses a scoped IAM user access key because the same credential is
currently synchronized into managed GitHub Actions. It needs ECS lifecycle and
observation permissions, exact-repository ECR read/push access, read-only
EC2/ELB prerequisite inspection, and `iam:GetRole` plus `iam:PassRole` on only
the configured task roles. The `serviceLongArnFormat` account setting must be
enabled. This first slice supports the commercial `aws` partition; temporary
STS and GitHub OIDC credential lifecycles are future work.

Promotion requires an isolated AWS account with the external prerequisites and
a live harness that can execute the managed workflow before proving
create/release/noop/update/terminal teardown. The current local fixture can
exercise spec/plan/apply but cannot publish and run the workflow, so green
mocked tests do not justify `ready-for-live` or `supported`.

Azure Container Apps is the next hosting-only adapter slice. The Azure
subscription, resource group, Microsoft Entra service principal, and Azure
Container Registry are externally owned. Hypervibe owns one managed environment
per Hypervibe environment and one Container App per web or worker service so
configuration and deletion remain action-scoped. Existing name matches require
explicit `hv_import`, stale ARM resource-ID bindings block, and teardown removes
the managed environment only after every owned Container App is
provider-confirmed absent. Container Apps Jobs and cron workloads remain outside
this adapter because they have a separate resource lifecycle.

Azure Container Apps remains `planned`. Its mocked contracts pin complete ARM
pagination, durable-ID-first observation, unknown-error preservation, duplicate
and unbound identity blocking, secret-safe configuration updates,
partial-create identity, billable confirmation, native source-control
disconnection, and idempotent terminal deletion. The generated workflow pushes
one `linux/amd64` image tagged with the full checked-out Git SHA to an existing
ACR registry, deploys the registry-reported digest only to already-bound
Container App ARM IDs, waits for the unique revision to become ready, verifies
the provider-reported image/SHA markers, and checks web health paths. CI never
creates a resource group, registry, role assignment, managed environment,
Container App, or source control.

The connection uses a Microsoft Entra application service principal. At the
managed resource-group scope it needs Container Apps Contributor and Container
Apps ManagedEnvironments Contributor. At the exact existing registry scope it
needs Reader plus AcrPush for classic Registry RBAC, or Container Registry
Repository Writer for an ABAC-enabled registry. Hypervibe authenticates through
ARM and ACR directly and never depends on `az`.

Promotion requires an isolated Azure subscription/resource group and existing
ACR registry plus a live harness that can run the managed workflow and prove
create/release/noop/update/terminal teardown. Service creation is
confirmation-gated because Container Apps and supporting managed-environment
resources can be billable, and cleanup failures must preserve the remaining ARM
resource IDs.

The extended matrix also includes:

- [Azure Database for PostgreSQL Flexible Server](https://learn.microsoft.com/en-us/rest/api/postgresql/)
  for PostgreSQL, and [Azure Managed Redis](https://learn.microsoft.com/en-us/azure/redis/overview)
  for Redis. They use separate provider ids from Azure Container Apps because
  they have independent
  resource types, durable identities, observation, and deletion lifecycles,
  while sharing the core Microsoft Entra, subscription, resource-group, and
  location fields. Azure Container Apps additionally binds an existing ACR
  registry by resource ID and login server.
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

The planned ECS contract declares its complete future live credential shape:
`HYPERVIBE_TEST_AWS_ACCESS_KEY_ID`,
`HYPERVIBE_TEST_AWS_SECRET_ACCESS_KEY`, optional
`HYPERVIBE_TEST_AWS_REGION`, `HYPERVIBE_TEST_AWS_ECR_REPOSITORY_ARN`,
`HYPERVIBE_TEST_AWS_ECR_REPOSITORY_URI`,
`HYPERVIBE_TEST_AWS_SUBNET_IDS_JSON`,
`HYPERVIBE_TEST_AWS_SECURITY_GROUP_IDS_JSON`,
`HYPERVIBE_TEST_AWS_EXECUTION_ROLE_ARN`, optional
`HYPERVIBE_TEST_AWS_TASK_ROLE_ARN`, and
`HYPERVIBE_TEST_AWS_TARGET_GROUP_ARN` for the public web fixture. Optional
`HYPERVIBE_TEST_AWS_PUBLIC_URL` pins the routed origin when the fixture is not
served by the default HTTP action. Array values
are parsed explicitly as JSON by the live runner instead of being passed to the
provider as strings.

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
