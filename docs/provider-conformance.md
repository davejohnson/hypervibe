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

DigitalOcean App Platform, Managed PostgreSQL, and Managed Valkey are
`ready-for-live`. Hypervibe generates a provider-owned GitHub
Actions workflow that publishes one DOCR image tagged with the exact checked-
out Git SHA, updates only already-bound App Platform components, waits for that
exact deployment ID to become `ACTIVE`, and verifies the active component
image. It never creates a container registry, app, or component from CI. A
verified connection must name an existing registry with `containerRegistry`,
supplied to the live runner as
`HYPERVIBE_TEST_DIGITALOCEAN_REGISTRY`.

The review-gated managed-workflow harness and provider-neutral Docker fixture
can now prove one full desired-state stack: App Platform, Managed PostgreSQL, and
Managed Valkey create/observe/wire, exact-SHA deploy, noop, update, dependency-
ordered destruction, and terminal absence. Promotion to `supported` still
requires one successful opt-in run against an isolated DigitalOcean team and
existing DOCR registry.

Render is the second combined hosting/database/cache slice. One registered
deployment provider binds an existing Render workspace, creates image-backed
web/private/worker/cron services, and derives Render Postgres and Render Key
Value adapters. The workspace is a shared provider context, not a resource
Hypervibe owns or deletes. A verified connection must include `apiKey` and
`ownerId`; managed exact-SHA hosting also requires the durable ID of an
existing GitHub Container Registry credential as `registryCredentialId`.
Hypervibe verifies that credential but never creates, rotates, or deletes it
from a service or CI action.

Render hosting, PostgreSQL, and Key Value are `ready-for-live`. Their mocked
contracts pin durable-ID-first observation, complete
cursor pagination, unbound-name adoption blocking, secret-safe connection
handling, partial-create identity, and provider-confirmed terminal deletion.
Service creates are marked billable and exact-action confirmation-gated because
Render workers, cron jobs, private services, and the default service plan can
incur charges.

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

The review-gated managed-workflow harness and provider-neutral Docker fixture
can now prove one full desired-state stack: Render Service, Postgres, and Key Value
create/observe/wire, exact-SHA deploy, noop, update, dependency-ordered
destruction, and terminal absence. Promotion to `supported` still requires one
successful opt-in run against an isolated workspace and existing GHCR
credential.

Heroku is the next hosting-only adapter slice. The provider context is the
verified Heroku account, which Hypervibe binds but never creates or deletes.
Each Hypervibe web or worker service owns one container-stack Heroku app so
config-var and process lifecycles remain action-scoped. Apply creates only an
empty, deterministically named app and records its durable app UUID; existing
name matches require explicit `hv_import`, stale UUID bindings block, and
teardown waits for provider-confirmed `404` absence. Add-ons, Scheduler jobs,
pipelines, and dashboard GitHub integrations are outside this adapter.

Heroku is `ready-for-live`. Its mocked contracts pin complete Platform API
range pagination, durable-ID-first observation, unknown-error preservation,
secret-safe config handling, partial-create identity, billable confirmation,
and idempotent terminal deletion. The generated managed workflow builds the
full checked-out Git SHA for `linux/amd64`, pushes the resulting image to only
the already-bound app/process registry paths, releases the exact Docker image
ID through Heroku's container-release Platform API, waits for the new release
to succeed, verifies its SHA/image markers and formation, and checks configured
web health paths. CI never creates an app, add-on, database, or pipeline.

The review-gated managed-workflow harness and provider-neutral Docker fixture
can now prove create/release/noop/update/terminal teardown. Promotion to
`supported` still requires one successful opt-in run in an isolated Heroku
account. The default Basic dyno becomes billable when the workflow scales the
process to one, so the live run must preserve exact-action confirmation and
surface cleanup failures with the remaining app UUID.

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

AWS ECS is `ready-for-live`. Its mocked contracts pin complete token
pagination, long-form durable ARN validation, provider-confirmed `MISSING`
semantics, unknown-error preservation, duplicate and unbound identity
blocking, partial create identity, immutable task-definition configuration,
billable confirmation, dependency-ordered terminal deletion, and safe
task-definition cleanup. Apply creates a zero-task ECS service using a public
Alpine bootstrap task definition, so it does not deploy application code or
start billable Fargate tasks before the reviewed CI action.

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

The review-gated managed-workflow harness and provider-neutral Docker fixture
can now prove create/release/noop/update/terminal teardown. Promotion to
`supported` still requires one successful opt-in run in an isolated AWS
account with all external prerequisites.

Azure Container Apps is the hosting side of the Azure adapter slice. The Azure
subscription, resource group, Microsoft Entra service principal, and Azure
Container Registry are externally owned. Hypervibe owns one managed environment
per Hypervibe environment and one Container App per web or worker service so
configuration and deletion remain action-scoped. Existing name matches require
explicit `hv_import`, stale ARM resource-ID bindings block, and teardown removes
the managed environment only after every owned Container App is
provider-confirmed absent. Container Apps Jobs and cron workloads remain outside
this adapter because they have a separate resource lifecycle.

Azure Container Apps is `ready-for-live`. Its mocked contracts pin complete
ARM pagination, durable-ID-first observation, unknown-error preservation,
duplicate and unbound identity blocking, secret-safe configuration updates,
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

Azure Database for PostgreSQL Flexible Server and Azure Managed Redis are now
`ready-for-live` under their independent `azure-postgres` and
`azure-managed-redis` provider ids. Both use the same Microsoft Entra,
subscription, resource-group, and location credential fields as the hosting
adapter, without requiring the hosting adapter's ACR fields. The PostgreSQL
adapter creates a generated-password Flexible Server, logical `app` database,
and Azure-services firewall subresource. The Redis adapter creates a TLS-only
Managed Redis cluster and its default database, then retrieves its access key
only for encrypted local runtime wiring. Their receipts never contain the
generated password, access key, or connection URL.

The review-gated managed-workflow harness and provider-neutral Docker fixture
can now prove the combined Container Apps, PostgreSQL, and Managed Redis stack:
create/observe/wire, exact-digest release, noop, update, dependency-ordered
destruction, and terminal absence. Promotion to `supported` still requires one
successful opt-in run in an isolated Azure subscription/resource group with
an existing ACR registry. All three creates are confirmation-gated because
they can be billable, and cleanup failures preserve the remaining ARM resource
ids.

The extended matrix also includes:

- [Azure Database for PostgreSQL Flexible Server](https://learn.microsoft.com/en-us/rest/api/postgresql/)
  for PostgreSQL, and [Azure Managed Redis](https://learn.microsoft.com/en-us/azure/redis/overview)
  for Redis. They use separate provider ids from Azure Container Apps because
  they have independent resource types, durable identities, observation, and
  deletion lifecycles, while sharing the core Microsoft Entra, subscription,
  resource-group, and location fields. Azure Container Apps additionally binds
  an existing ACR registry by resource ID and login server.
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
  The replacement hosting slice binds a verified personal or Team scope,
  creates one source-less Project per logical web service, and keeps project,
  production-variable, and deletion mutations inside spec/plan/apply. Its
  managed workflow uploads the exact checked-out files through the REST API,
  reconciles deployments by repository and full Git SHA before creating one,
  and blocks Vercel-native Git links. It supports public framework/static web
  projects and rejects arbitrary long-lived start commands or build overrides
  it cannot apply. Its review-gated managed-workflow harness is now available,
  so the matrix entry is `ready-for-live`; promotion still requires a
  successful opt-in create/deploy/noop/update/destroy run.
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

The ECS managed-workflow contract declares its complete live credential shape:
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
served by the default HTTP action. Optional
`HYPERVIBE_TEST_AWS_ASSIGN_PUBLIC_IP` and
`HYPERVIBE_TEST_AWS_CONTAINER_PORT` override the network defaults. Array
values are parsed explicitly as JSON by the live runner instead of being
passed to the provider as strings.

The runner copies a tiny HTTP fixture into a temporary worktree and writes a
mode-`0600` temporary credential object. Hypervibe consumes it through
`credentialsRef=file:...`; the file is deleted immediately after connection
verification. Values are never passed as CLI arguments or printed. The test
removes its services, databases, and caches through spec/plan/apply, and its
`afterAll` repeats that desired-state cleanup after a partial test failure.

## Running a managed-workflow live test

Providers whose first application release must run through a managed GitHub
Actions workflow use a separate review-gated harness. These hosting profiles
are enabled:

| Provider id | Fixture directory | Workflow | Managed datastores | Health URL |
| --- | --- | --- | --- | --- |
| `vercel` | `test/provider-conformance/fixture-vercel` | `deploy-vercel-production.yml` | none | HTTPS `/api/health` |
| `digitalocean` | `test/provider-conformance/fixture` | `deploy-digitalocean-production.yml` | PostgreSQL + Valkey | HTTPS `/health` |
| `render` | `test/provider-conformance/fixture` | `deploy-render-production.yml` | Postgres + Key Value | HTTPS `/health` |
| `heroku` | `test/provider-conformance/fixture` | `deploy-heroku-production.yml` | none | HTTPS `/health` |
| `ecs` | `test/provider-conformance/fixture` | `deploy-ecs-production.yml` | none | HTTP or HTTPS `/health` |
| `azure-container-apps` | `test/provider-conformance/fixture` | `deploy-azure-container-apps-production.yml` | PostgreSQL + Managed Redis | HTTPS `/health` |

The harness never merges its own infrastructure pull request: it applies the
reviewed plan, prints the Hypervibe PR URL, waits for a human merge, and then
continues through `hv_ci_trigger`, `hv_ci_status`, `hv_health`, noop/update
checks, and spec-driven teardown. Teardown may produce a second infrastructure
PR that removes durable service ids from the workflow; the harness waits for
that review too. Exact-SHA proof comes from the successful Hypervibe
server-release evidence artifact tied to the observed workflow run, not from
GitHub's dispatch-ref `head_sha`.

Use a disposable checkout of a dedicated GitHub repository and an isolated
provider account, Team, subscription, or resource group. Copy the tracked
files from the selected profile's fixture directory into the repository. Add
this canonical `.hypervibe/spec.json`, replacing the project, repository, and
provider:

```json
{
  "version": 1,
  "project": "hypervibe-managed-live",
  "gitRemoteUrl": "https://github.com/OWNER/REPOSITORY.git",
  "secrets": {},
  "environments": {
    "production": {
      "hosting": {
        "provider": "PROVIDER"
      },
      "services": {
        "web": {
          "workloadKind": "web",
          "healthCheckPath": "/api/health",
          "public": true
        }
      },
      "email": {
        "enabled": false
      },
      "envVars": {
        "HYPERVIBE_CONFORMANCE_REVISION": "create"
      },
      "deploy": {
        "strategy": "branch",
        "trigger": "ci",
        "branch": "main",
        "autoDeploy": false
      }
    }
  }
}
```

For `vercel`, use provider `vercel` and keep the service block above. For
`digitalocean`, `render`, `heroku`, `ecs`, or `azure-container-apps`, use that
provider id and replace the service block with this exact object:

```json
{
  "workloadKind": "web",
  "startCommand": "node server.mjs",
  "healthCheckPath": "/health",
  "public": true
}
```

The `digitalocean` profile also requires these environment fields:

```json
"database": {
  "provider": "digitalocean",
  "engine": "postgres"
},
"cache": {
  "provider": "digitalocean",
  "engine": "redis"
}
```

The `render` profile requires the same fields with provider `render`.
Hypervibe creates and wires these datastores during plan/apply; the GitHub
workflow only deploys the already-bound service and never mutates a datastore.

The `azure-container-apps` profile requires:

```json
"database": {
  "provider": "azure-postgres",
  "engine": "postgres"
},
"cache": {
  "provider": "azure-managed-redis",
  "engine": "redis"
}
```

Commit and push those files to `main` before running the harness. The test
proves the local spec is byte-for-byte committed at `HEAD` and that every
required fixture path is tracked before it can create a provider resource.
`HYPERVIBE_LIVE_DATA_DIR` must be a persistent absolute directory; interrupted
runs retain encrypted connection state, durable bindings, and cleanup
authority there instead of losing them in a temporary directory.

Export:

```sh
export HYPERVIBE_LIVE_REPOSITORY_WORKTREE="/absolute/path/to/disposable-checkout"
export HYPERVIBE_LIVE_DATA_DIR="/absolute/path/to/persistent-live-state"
export HYPERVIBE_TEST_GITHUB_REPOSITORY="OWNER/REPOSITORY"
export HYPERVIBE_TEST_GITHUB_API_TOKEN="<fine-grained repository PAT, or classic PAT with repo + workflow>"

# Select exactly one configured provider:
export HYPERVIBE_TEST_VERCEL_ACCESS_TOKEN="<Vercel personal or Team token>"
# Required only when the token should operate in a Team:
export HYPERVIBE_TEST_VERCEL_TEAM_ID="team_..."
HYPERVIBE_LIVE_MANAGED_HOSTING=vercel npm run test:providers:managed-live

# Or, after exporting the AWS variables listed above:
HYPERVIBE_LIVE_MANAGED_HOSTING=ecs npm run test:providers:managed-live

# Or, after exporting the Azure variables listed below:
HYPERVIBE_LIVE_MANAGED_HOSTING=azure-container-apps npm run test:providers:managed-live

# Or, after exporting the provider variables described below:
HYPERVIBE_LIVE_MANAGED_HOSTING=digitalocean npm run test:providers:managed-live
HYPERVIBE_LIVE_MANAGED_HOSTING=render npm run test:providers:managed-live
HYPERVIBE_LIVE_MANAGED_HOSTING=heroku npm run test:providers:managed-live
```

The recommended GitHub credential is a
[fine-grained repository PAT](https://github.com/settings/personal-access-tokens/new)
whose selected repository is only the isolated fixture. Grant Metadata read
plus Administration, Actions, Contents, Pull requests, Secrets, and Workflows
read/write. A classic PAT with `repo` and `workflow` also works but cannot be
restricted to one repository. The credential is stored through a repository-
scoped `credentialsRef`; none of these hosting profiles needs package-read
permission on that repository-management token. Render's separately configured
GHCR pull credential does need `read:packages`. The
Vercel credential is a
[personal access token](https://vercel.com/account/settings/tokens) scoped to
the intended personal account or Team. It must be able to read that scope and
create, configure, deploy, and delete Projects there; include the immutable
`teamId` for a Team-scoped run. The harness writes temporary
mode-`0600` credential files inside the persistent data directory and removes
them immediately after Hypervibe verifies each connection; values never enter
command arguments, plans, receipts, or test output.

For DigitalOcean App Platform, create a
[custom-scope PAT](https://cloud.digitalocean.com/account/api/tokens) for the
isolated team. Grant `app:read`, `app:create`, `app:update`, `app:delete`,
`registry:read`, and `registry:update`, plus the region, size, and action read
scopes described in the DigitalOcean section above. Export
`HYPERVIBE_TEST_DIGITALOCEAN_TOKEN` and
`HYPERVIBE_TEST_DIGITALOCEAN_REGISTRY`. The existing DOCR registry remains
externally owned and is not removed by the test. The full-stack profile also
requires `database:read`, `database:view_credentials`, `database:create`,
`database:update`, and `database:delete`; the created PostgreSQL and Valkey
clusters are billable and are removed by exact confirmed actions during
teardown.

For Render, create a personal
[API key](https://dashboard.render.com/u/settings#api-keys) whose user can
manage services in the isolated workspace. Export
`HYPERVIBE_TEST_RENDER_API_KEY`, `HYPERVIBE_TEST_RENDER_OWNER_ID`, and
`HYPERVIBE_TEST_RENDER_REGISTRY_CREDENTIAL_ID`. The registry credential must
already exist in that workspace, target GHCR, and contain a narrowly scoped
GitHub token with `read:packages`; Hypervibe verifies and reuses it but does
not create, rotate, or delete it. The user behind the API key must also be able
to create, inspect, and delete Postgres and Key Value resources in that
workspace. Both resources can be billable and are removed by exact confirmed
actions during teardown.

For Heroku, use an Account Settings API key or preferably a revocable
[OAuth direct-authorization token](https://devcenter.heroku.com/articles/oauth#direct-authorization)
whose user can manage apps in the isolated account/team. Export
`HYPERVIBE_TEST_HEROKU_API_KEY`; optionally set
`HYPERVIBE_TEST_HEROKU_REGION` and `HYPERVIBE_TEST_HEROKU_DYNO_SIZE`. Heroku
tokens are not app-scopeable, and the selected dyno becomes billable when the
managed workflow scales it to one.

For ECS, create a scoped IAM user
[access key](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_credentials_access-keys.html)
for the isolated account. It needs the ECS, ECR, EC2/ELB inspection, and
role-scoped IAM permissions described in the AWS section above; restrict ECR
pushes to the exact repository and `iam:PassRole` to the configured execution
and task roles. Export the complete AWS credential shape listed in the
opt-in-live section. The configured subnets, security groups, target group,
roles, repository, and ALB routing remain externally owned and are not removed
by the test.

For Azure Container Apps, create a Microsoft Entra application
[service principal](https://learn.microsoft.com/en-us/entra/identity-platform/howto-create-service-principal-portal)
for the isolated subscription. Export
`HYPERVIBE_TEST_AZURE_TENANT_ID`,
`HYPERVIBE_TEST_AZURE_SUBSCRIPTION_ID`,
`HYPERVIBE_TEST_AZURE_CLIENT_ID`,
`HYPERVIBE_TEST_AZURE_CLIENT_SECRET`,
`HYPERVIBE_TEST_AZURE_RESOURCE_GROUP`,
`HYPERVIBE_TEST_AZURE_LOCATION`,
`HYPERVIBE_TEST_AZURE_REGISTRY_ID`, and
`HYPERVIBE_TEST_AZURE_REGISTRY_SERVER`. Grant the resource-group and exact-ACR
roles described in the Azure section above. The resource group, registry, and
role assignments remain externally owned and are not removed by the test.
The same service-principal values are stored as separate verified
`azure-postgres` and `azure-managed-redis` connections by the harness. At the
resource group, grant the PostgreSQL ARM permissions and Azure Managed Redis
Contributor role documented by `hv_connections_list`. The test owns and
removes its Flexible Server, Azure-services firewall rule, logical database,
Managed Redis cluster, and default Redis database.

The default review and workflow timeouts are 30 minutes. Override them with
positive millisecond values in `HYPERVIBE_LIVE_REVIEW_TIMEOUT_MS` and
`HYPERVIBE_LIVE_WORKFLOW_TIMEOUT_MS`. If a review or workflow fails, the
`afterAll` stage still changes the spec to desired-absent for the service and
any declared database/cache, confirms every exact destroy action, waits for
provider-confirmed absence, and preserves the data directory if cleanup cannot
be proven. Do not delete that directory until the test reports verified
teardown.

Until the environment desired-absent lifecycle is implemented, the final live
provider-context/local-binding assertion remains a test-first `todo`. A live
run may therefore leave an empty provider project/environment context, but it
must not leave a workload, database, or cache. Use only an isolated provider
account/project intended for testing. Do not enable a provider in shared CI
until the final assertion is executable and cleanup failures surface the
remaining provider resource identities.
