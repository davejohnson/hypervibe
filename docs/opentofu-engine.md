# GCP engine implementation notes

Google Cloud uses OpenTofu as its only infrastructure engine. Cloud Run selects
it automatically; there is no engine setting. Default planning routes
to the engine and unsupported work blocks without a legacy fallback.

This page records engine ownership, implementation decisions and dated evidence.
Product scope and future priorities belong to the
[common user journey](development/user-journey.md). It is not a complete support
claim or a separate roadmap.

The dated live evidence below describes earlier revisions. It does not establish
that the current cutover has been deployed live. Verification for a later change
belongs in that change's pull request; the historical results remain bounded to
the runs described here.

## Existing-zone DNS engine

DNS records now use the same saved-plan boundary with pinned Cloudflare, Google
Cloud DNS, Route 53 and Azure DNS backends. `environment.dns` selects the provider
and exact existing zone independently of hosting. Hypervibe retains read-only
scope/ownership checks, explicit adoption, consumer ordering and certificate
readiness; OpenTofu owns record changes and encrypted native state. Domain
and email workflows do not invoke the historical direct record writers.

See the [DNS setup examples](domain-security-readiness.md#explicit-dns-intent). Zone creation,
DNSSEC/registrar changes and automatic CAA security policy mutations remain
unavailable. All four pinned provider configurations and local boundaries are
checked in ordinary CI, but their installed live lifecycle is unverified. The
dated domain evidence below predates this DNS engine and does not validate it.

## Decision

OpenTofu and the pinned Google provider own GCP infrastructure lifecycle, while Hypervibe keeps the product:
deciding what to build, the spec, approvals, secret ownership, redaction,
builds/releases, data operations and operation history. Users keep using
`hv_spec` → `hv_plan` → `hv_apply` → verification and never see OpenTofu.

The engine is shared and cloud-neutral. Each cloud supplies a backend with its own
configuration, authentication, resource identities and deployment behavior.

## Ownership map

| Responsibility | Owner |
| --- | --- |
| Understand the app, choose infrastructure, desired spec | Hypervibe |
| Explain changes and collect approval | Hypervibe |
| Calculate resource changes for migrated GCP resources | OpenTofu + Google provider |
| Execute those reviewed changes (the exact saved plan) | OpenTofu |
| Provider resource state | OpenTofu (encrypted, Hypervibe-held key) |
| Secret ownership, generation, rotation, redaction | Hypervibe |
| Builds, releases, logs, DB queries, migrations, recovery, health | Hypervibe (retained adapters) |
| Project identity, bindings, approval records, history | Hypervibe |

## Implementation

The evidence column records the original engine work; it is not a fresh run of
every listed component on the current revision.

| Piece | File | Evidence |
| --- | --- | --- |
| Cloud-neutral engine contract | `src/domain/ports/infrastructure-engine.port.ts` | Type-checked; nothing Google-specific |
| Process runner (no inherited env, timeout, SIGINT cancel, exact-value + pattern redaction, version pin check) | `src/adapters/engine/opentofu/runner.ts` | Live tests |
| Private durable state, per-state key in Hypervibe's secret store, enforced state **and** plan encryption, generated lock file, pre-apply backups, refusal to mint a new key for existing state | `src/adapters/engine/opentofu/workspace.ts` | Live tests |
| Saved plan → Hypervibe actions; unmapped addresses and `forget` block the plan; replace/delete require confirmation; apply events → per-address outcome | `src/adapters/engine/opentofu/plan-mapping.ts` | Unit + live tests |
| Plan/apply of the exact reviewed artifact (plan digest, config digest, engine + provider versions, full-approval check) | `src/adapters/engine/opentofu/engine.ts` | Live tests |
| Executor **engine segment**: one saved plan runs once; each action gets its own receipt; members report real outcomes even after an earlier failure; external prerequisites must complete first | `src/domain/plan/converge.executor.ts` | `engine-segment.executor.test.ts` |
| GCP backend: Cloud Run v2 service + public invoker, Secret Manager *references*, digest-pinned images, narrow image ownership, pinned Google provider 8.9.0 | `src/adapters/providers/gcp/tofu/gcp-engine.backend.ts` | Validated by the real provider |

Pinned: OpenTofu **1.13.9**, `hashicorp/google` **8.9.0**, with archive checksums
(darwin/linux × arm64/amd64) and lock hashes recorded in source. `tofu init` runs
with `-lockfile=readonly`, so an unexpected package fails closed.

### Live evidence (2026-11-05)

`HYPERVIBE_TOFU_BINARY=<tofu 1.13.9> npx vitest run src/adapters/engine` ran the
real binary (no cloud account needed except the provider download):

- Generated Cloud Run configuration validates against the pinned Google provider.
- Create → apply → second plan is noop with no engine segment.
- Re-applying the consumed saved plan is rejected by OpenTofu as stale.
- A tampered plan file, or approval of only part of a saved plan, is refused before start.
- With three resources where one fails, receipts are `succeeded`/`failed` per address.
- A representative secret passed as a sensitive input never appears in the saved
  plan, the state file or diagnostics; the state file contains no plaintext at all.
- Removing the key for existing state blocks instead of creating a new key.

Read-only auth probe through the saved `cloudrun` connection for
`davejohnson/hls-property-care`: OpenTofu authenticated as
`hypervibe-deploy@hls-property-care.iam.gserviceaccount.com` and read project
`hls-property-care`. Data sources only; no state written, nothing changed.

At this initial probe, real GCP resource mutations were not yet proven. The later
live journey below records create, update and delete results from the same date.

## Decisions made while building

- **Encryption config via `TF_ENCRYPTION`** (HCL), never a file, so the passphrase
  exists only in the engine process environment and is redacted from output.
  OpenTofu needs static references here; the JSON form with `${...}` is rejected.
- **Lock hashes must include `h1:`** entries, not only the upstream `zh:` archive
  checksums, or validation fails after init. The recorded list came from
  `tofu providers lock` for the four supported platforms.
- **Partial engine applies are refused.** Approval must cover every address in the
  saved plan. A smaller change set needs a new reviewable plan.
- **Only an `apply_complete` event proves success.** Started-but-unfinished work is
  `unknown` → a `pending` receipt that tells the agent to observe before retrying.
  There is no automatic fallback to direct API writes.
- **`deletion_protection = false`** on engine-managed services: Hypervibe's
  confirmation gate governs deletion; provider-side protection would only break an
  approved teardown.

## Release ownership with CI (Cloud Run)

The engine ignores only `template[0].containers[0].image` plus the `client` and
`client_version` markers. Every other template field stays engine-managed, so an
infrastructure apply keeps whatever image is running instead of rolling it back.
Google provider ≥ 5 treats `labels`/`annotations` as non-authoritative, so the
release annotations CI writes are not reverted.

The current engine CI writer is
[`infrastructure-engine-ci.ts`](../src/application/infrastructure-engine-ci.ts).
It preserves the read container configuration, changes the image and includes the
service `etag` in its PATCH; workflow coverage is in
[`engine-ci-workflow.test.ts`](../src/application/__tests__/engine-ci-workflow.test.ts).
The release boundary still requires image/release-metadata changes only and an
`etag` on every write. The November 5–6 live runs below did not exercise CI
releases, so they do not verify this later implementation or concurrent
release/apply behavior live.

## Runtime secrets

OpenTofu owns secret containers. Hypervibe keeps credential generation, private
value storage and version publication inside its operational secret boundary.
Raw credential values do not belong in public plans or generated configuration.
Cloud Run receives Secret Manager references.

### Limiting a secret to named services

A secret declaration may list `services`. Its reference then goes only to those
services, workers and scheduled jobs, in every environment the secret targets,
and only their identities can read it from the cloud's secret store. Without
the list, every service receives it and nothing changes for an existing spec.

```json
"secrets": {
  "SOURCE_API_KEY": {
    "ownership": "delegated",
    "principal": "source system administrator",
    "environments": ["staging"],
    "services": ["catchup"]
  }
}
```

- Every named service must exist in every environment the secret targets.
- The release command borrows the web service's configuration and identity, so
  it holds a limited secret only when the web service does.
- A service that some limited secret names runs as its own identity. Services
  that no limited secret names keep the shared runtime identity.
- Railway cannot limit a secret. A spec that asks for it there is refused; the
  secret is never given to every service instead. `services` cannot be combined
  with `credential` tracking.
- People and tools that administer the cloud account can still read every
  secret: the deployment identity, the CI release identity (it can release a
  service that runs as the named identity), and account owners. The boundary is
  between an environment's own services.

#### Google Cloud

Setup grants the shared runtime identity Secret Accessor on the whole project,
so leaving a secret out of a service's environment is not enough. Two things
make the limit real, and both are project IAM that only an administrator can
change, so they are one reviewed setup step
(`hv_connections provider="cloudrun" action="prepare" environment="<env>" secretScopeAccess="lifecycle"`,
preview then confirm):

1. Each named service gets its own service account. The deployment identity
   (and the CI release identity, when CI is set up) may deploy as it. It
   receives the shared identity's Cloud SQL and Pub/Sub project roles, object
   access only on the buckets the service is wired to (`injectInto`), and
   project-wide Secret Accessor.
2. Every project-wide Secret Accessor grant that must not reach a limited
   secret carries an IAM condition excluding that secret and its versions: the
   shared runtime identity's grant, and the grant of every service identity the
   secret does not name. Changing a condition replaces the grant; the new grant
   is created before the old one is removed.

A grant is narrowed only once no workload that runs as that identity still
holds the secret, because Cloud Run cannot start an instance whose identity
lost a secret it references. Hypervibe records, from each refreshed plan and
each completed apply, what every workload runs as and references. So:

Which flow applies depends on whether the environment has ever created the
secret, not on whether you consider it new:

- **The environment has never created the secret** (it is not yet in Secret
  Manager for this environment), or the environment has no workloads yet: the
  first setup step already closes it to the shared identity. Run the setup
  step, check that its result lists the secret under `cannotRead` for the
  shared runtime identity and nothing under `notYetEnforced`, then `hv_plan`
  and `hv_apply`. The value is stored only after the secret is closed.
- **The secret already exists in the environment** (services hold it, or held
  it), or its list of services changes: three steps.
  1. Setup step. It creates identities and narrows nothing; its result says
     `NOT YET ENFORCED`.
  2. `hv_plan` and `hv_apply`. The named service moves to its identity; the
     others drop the reference. The plan warnings, the `hv_apply` result and
     `hv_status` all say `NOT YET ENFORCED` or name the next step, and further
     plans for the environment are blocked.
  3. Setup step again. It narrows the grants and verifies them.
  Until step 3 is confirmed and verified, every service that runs as the shared
  identity can still read the secret. **Do not store or rotate in the real
  value before then.** If the secret already holds a real value, treat it as
  known to the other services and rotate it after step 3.

When in doubt, read the setup result: a secret is enforced only when it is
absent from `notYetEnforced`.

After a confirmed setup Hypervibe reads, with the administrator sign-in:

- the project IAM policy: each identity has exactly one Secret Accessor
  binding with exactly the reviewed condition, and no workload identity holds
  Owner, Editor, Secret Manager Admin, Service Account User, Token Creator,
  Service Account Admin, Workload Identity User, Security Admin, Project IAM
  Admin, Cloud Run Admin or Cloud Run Developer on the project;
- the IAM policy of each limited secret that exists: no excluded identity (and
  not everyone) holds any role directly on it;
- each service identity: present, enabled, and no other workload identity (and
  not everyone) holds any role on it, so none can act as it or mint its tokens.

Anything that cannot be read counts as not enforced. Not checked: custom
roles, bindings inherited from a folder or the organisation, and changes made
in Google Cloud after the check. The check runs when setup is confirmed, not on
every plan.

A missing local workload record never reopens a secret: an exclusion the saved
setup already has is kept.

`hv_plan` is blocked whenever the verified setup is not exactly what the spec
and the recorded workloads call for: a missing identity, a secret the shared
identity can still read after services stopped holding it, or a lock that would
deny a service a secret the plan is about to give it. The record of verified
setup and of workloads is local to the machine that ran setup and apply.

Refused instead of weakened:

- a limited secret that names an on-demand worker (its waker must act as the
  worker's identity);
- `gcpRuntimeSecretGrants` together with a limited secret, and any per-secret
  grant to the shared identity that is still recorded;
- a project that carries the migration copy restriction on the same grant.

Not isolated: every identity can read secrets that name no services, including
those of other environments in the same Google Cloud project. Database access
is shared (one database login per environment). Pub/Sub roles are project-wide
for every identity. The shared runtime identity keeps project-wide object
access where storage setup granted it; only service identities are limited to
their buckets. A service identity stays in the project after its service stops
being named.

#### AWS

Each named service runs as its own IAM role (task and execution role), and only
those roles list the secret's Parameter Store parameter. Every other workload
keeps the shared runtime role, which in such an environment can no longer read
the parameter, start tasks, pass roles or change schedules: with those it could
start the named job with its own command and print the value. Scheduled jobs
and on-demand worker wakers are started by a separate control role that only
AWS's scheduler services can assume and that cannot read parameters. The CI
release role may pass exactly the roles of the workloads it releases. All of
this is in the environment's own plan; there is no separate setup step.

Limiting a secret on a live environment adds the roles, updates policies,
schedules and services in place and registers new task definition revisions.
No bucket, database or stored parameter is replaced. In such an environment
each role's inline policy and managed-policy attachments are declared
exclusive, so a policy attached outside Hypervibe is removed by the next apply
instead of widening the role; nothing reads live IAM between applies. A package token
(`NPM_TOKEN`, `NODE_AUTH_TOKEN`) cannot be limited. AWS has no release command.

Not isolated: storage buckets (every role keeps every bucket of the
environment) and the database login are shared by all services.

#### Azure

Each named service runs as its own user-assigned managed identity, the only
identity attached to that Container App or job. It holds Key Vault Secrets User
on each secret it receives, one assignment per secret. The shared runtime
identity keeps no role on a limited secret or on any scope that contains it.
All of this is in the environment's own plan. Each plan with a limited secret
also lists the shared identity's role assignments in Azure and is blocked if a
built-in role that reads vault secrets, changes access or uses other
identities (Key Vault Secrets User/Officer/Administrator, Owner, Contributor,
User Access Administrator, RBAC Administrator, Managed Identity
Operator/Contributor) sits at the secret, its vault, the resource group or the
subscription. Custom roles, roles held through a group and management-group
scopes are not checked.

Limiting a secret on a live environment creates the identity and its roles,
removes the shared identity's role on that secret and updates the apps. For a
minute or two during that apply a named service that restarts may fail to load
the secret. A package token and the on-demand worker's scale-rule login cannot
be limited. Azure has no release command. With a limited secret the shared
identity's role wait is tied to its role set, so removing a limit waits for the
new role before the other apps are updated.

Not isolated: the database login is shared. Services that keep the shared
identity keep storage-account-wide access; a named service has storage access
only when storage is wired to it (`injectInto`), so a named service that used
storage without being wired loses it.

#### On every cloud

All services of an environment run the same image, so the limit protects
against one compromised service, not against whoever writes or releases the
code. A value that other services held before it was limited stays known to
them: rotate it after the limit is in force. A named service can still pass
the value on, for example by writing it to the shared database.

## Cross-cloud boundaries

Shared: runner, saved-plan handling, encryption, state layout, approvals, engine
segments and receipts. Per cloud: configuration, authentication, resource mapping.

- AWS and Azure must never need a Google account or GCS bucket for state. Local
  state is keyed by `provider/project/environment/partition`. A future shared
  backend is chosen per cloud (S3 for AWS, Blob for Azure, GCS for GCP).
- Secret Manager references stay inside the GCP backend.
- The Cloud Run CI image split is a GCP decision, not a model every cloud must use.
- AWS decisions (access, runtimes, database network): [OpenTofu engine on AWS](opentofu-engine-aws.md).
- Azure decisions (access, shared testing resources, runtimes, costs, teardown): [OpenTofu engine on Azure](opentofu-engine-azure.md).

## User interaction

The [common user journey](development/user-journey.md) owns the product contract
for all three clouds. Project creation, API enablement, IAM, deployment identities,
storage, secrets, deployment and verification belong to Hypervibe. Payment
verification and organization admin consent may still need a person. The GCP
implementation notes below do not establish that every step of that contract is
available or verified.

## GCP ownership

Project bootstrap and preparation use a separate project-shared OpenTofu state
for project/billing setup, APIs, identities, IAM, private build storage, image
repositories and keyless CI trust. Billing choice does not approve these changes;
the saved setup plan has its own confirmation.

To put production in its own Google Cloud project, set
`environments.production.hosting.gcpProjectId` alongside `provider: "cloudrun"`.
With `hv_migrate`, pass `gcpProjectId` when proposing the new target environment.
Subsequent calls use that saved selection. Run `hv_launch` for that environment,
or select the same environment in `hv_connections` for bootstrap and preparation.
The selected project has its own deployment credentials, setup state and access
checks. Environments that omit the field keep using the repository connection.
Moving a deployed environment requires a separate migration target.

Environment resources use environment-owned engine state. Operational helpers
verify prerequisites and stop if they are absent or unknown. Builds do not
create repositories; one-off tasks do not create runner infrastructure. Preserve
sign-in, credential values, image builds/releases, logs, health, SQL and object
transfer operations. Existing Railway infrastructure continues through its
retained lifecycle.

### Prepare the target app's secret access

In the target environment's existing Cloud Run hosting settings, set
`gcpRuntimeSecretGrants` to `"per-secret"` with `hv_spec`. Run `hv_plan` with
`scope="infrastructure"` and review each `secret-runtime-access:` action. It
names the Google secret and the service account that will receive Secret
Accessor on that secret's enabled versions. Confirm the desired actions with `hv_apply`. The environment owns
these grants, so removing a secret reference from every workload or removing
the setting produces a reviewed removal.

Only secrets referenced by a service, worker, scheduled job or release job
qualify. A build-only token, an empty import slot or a container merely found
in the project receives no grant from this preparation. Existing direct grants
outside the environment's engine state block implicit adoption. Hypervibe also
preserves an existing grant if its local apply record cannot confirm the
original secret, including after an interrupted apply. Project-wide
grants still apply, and the private transfer still needs its own reviewed job
and isolated credentials.

### App secret access on AWS and Azure

The Cloud Run setting applies only to Google Cloud. The other engines grant app
access as part of the environment's existing infrastructure plan.

- **AWS.** ECS uses one environment role for task execution and for running
  containers. Its app-secret policy names individual Parameter Store parameters.
  With an on-demand worker, that same role can read any Secrets Manager secret
  under `hypervibe/<environment-prefix>/`, where the worker's database login
  lives. The account deploy role can manage
  parameters and secrets across Hypervibe's namespace. The setup permissions
  boundary caps what an app role can receive. [AWS engine](opentofu-engine-aws.md)
  · [AWS permissions boundaries](https://docs.aws.amazon.com/IAM/latest/UserGuide/access_policies_boundaries.html)
- **Azure.** Container Apps and jobs share an environment identity with Key Vault
  Secrets User on each named app secret, including the query credential for an
  on-demand worker. The project's deployment identity holds Key Vault Secrets
  Officer on the resource group. Permissions inherited from a parent scope
  still apply alongside individual secret grants. [Azure engine](opentofu-engine-azure.md)
  · [Azure role scopes](https://learn.microsoft.com/en-us/azure/role-based-access-control/scope-overview)

These identities live with the environment or its deployment setup. Neither
engine provisions a temporary identity to copy a private database or files.
`hv_migrate` can copy runtime settings to AWS. Azure migration is unavailable.

## Flow exercised by the early GCP implementation

1. `hv_spec` with `environments.<env>.hosting = { provider: "cloudrun" }`.
2. `hv_connections action="bootstrap"`: preview, choose a billing account, confirm.
   Hypervibe creates the project, deployment and runtime identities and connections.
3. `hv_plan scope="infrastructure"` → `hv_apply` (with confirmations for billable or
   destructive actions). Hypervibe generates its secrets into Secret Manager;
   OpenTofu creates the services from a placeholder image (`cloudrun/container/hello`, pinned).
4. `hv_deploy` builds from the git remote and releases it: a recorded plan run under
   the environment lock that changes only the running image (etag-guarded), then
   checks the health path.
5. Teardown: remove services and secrets from the spec, plan, apply with confirmations.

The pinned OpenTofu binary is downloaded and checksum-verified on first use into
`~/.hypervibe/engine/bin`; providers are cached in `~/.hypervibe/engine/plugins`.

## Live journey (2026-11-05)

Fresh repository `davejohnson/hypervibe-engine-pilot`, fresh project
`hv-hypervibe-engine--eb0c996d`, separate Hypervibe data directory:

| Step | Result |
| --- | --- |
| Connect (bootstrap preview → billing choice → confirm) | Project, identities, verified connections |
| Plan/apply infrastructure | Secret generated + stored; service and public access created (per-address receipts) |
| Release v1 | Built as the deployment identity; image-only change; `/health` 200 with secret present |
| Release newer code (b2) | New digest running |
| Change config (`APP_VERSION` v1→v2) via OpenTofu | In-place template update; **b2 digest still running** |
| Plan with no changes | 0 actions |
| Plan → release b3 → apply old plan | **Refused** ("A service changed since this plan"); b3 kept |
| Unconfirmed teardown | Refused before any change |
| Confirmed teardown | Service then secret deleted; URL 404; next plan empty |

Not exercised in this November 5 run: CI releases (then blocked for engine
environments), concurrent multi-machine execution, Cloud SQL or domains. CI is
now implemented as described above; database and domain evidence follows below.

## Problems found and fixed along the way

- **New-project setup failed at step one.** Resource Manager answers 403 for a project
  id that does not exist; bootstrap treated that as an error. It now confirms with a
  project search and treats an invisible id as not yet created (creation is atomic on a
  globally unique id, so nothing foreign can be adopted).
- **Billing failures were opaque** ("HTTP 400"). Recognized Google conditions (billing
  account at its project limit, project quota, missing billing permission) now produce
  plain-language next steps.
- **Builds failed in new projects.** New projects build as the Compute Engine default
  account (Editor). Hypervibe never acts as it: setup now lets the deployment identity
  act as itself and write build logs, and builds fall back to running as that identity.
  This also affects the standard (non-engine) Cloud Run path.
- Pattern redaction could silently corrupt OpenTofu JSON; machine-readable output now
  uses exact-value redaction only, and every diagnostic gets the full scrub.
- An environment with no services generated invalid configuration, and deletions of
  removed services were flagged as unmanaged; both fixed for teardown.
- A saved plan could have rolled back a release made after it; applies now refuse when a
  service's generation changed since planning, and releases share the apply lock.

## Database, domain, storage, launch (2026-11-06)

| Capability | Ownership | Live evidence |
| --- | --- | --- |
| Cloud SQL Postgres | OpenTofu: instance (backups + PITR at creation; existing protection preserved), database. Hypervibe: login, generated password, `DATABASE_URL` secret | Created; login set; service wired in round 2; app writes/reads rows; later config apply kept login, data and image |
| Custom domain | Hypervibe: ownership proof (TXT + Site Verification API), DNS-only records, certificate wait. OpenTofu: Cloud Run domain mapping | `pilot.hypervibe.dev` verified and mapped with no Search Console step; certificate was still issuing when last checked |
| Cloud Storage | OpenTofu: private bucket, object access for the runtime identity | Validated and planned; not yet created live (see below) |
| Local-commit builds | Hypervibe: `git archive` of HEAD → private expiring bucket → Cloud Build as the deployment identity | An unpushed local commit was built and released |
| `hv_launch` | Orchestrates everything above | Stops at the cost/approval step with plain-language changes and estimates; the confirmed run was not executed (DNS for a new hostname needs owner approval) |
| Browser sign-in | Loopback OAuth + PKCE when no local Google login exists | Unit-tested; needs Hypervibe's registered Google OAuth client to run live |

Design notes:

- The database password never enters OpenTofu, so no engine apply can restore an old
  one. First deployments take two rounds (database, then wiring once the login exists);
  `hv_launch` runs both.
- The Google provider treats a pending certificate as success for domain mappings but
  fails when ownership is unverified, so verification and DNS precede the mapping.
- Hypervibe never overwrites DNS records it did not create and removes only the exact
  Google targets it wrote.

## Evidence boundaries and later implementation

The November 5–6 evidence leaves browser sign-in, a confirmed from-scratch
`hv_launch` with database, storage and a ready custom domain, and concurrent
multi-machine execution unverified. The November 6 domain certificate was still
issuing; storage was planned but not created. Those limits remain part of the
historical record, not claims about every later revision.

CI releases, scheduled jobs, Memorystore and Pub/Sub are now implemented in
[`infrastructure-engine-ci.ts`](../src/application/infrastructure-engine-ci.ts) and
[`gcp-engine.backend.ts`](../src/adapters/providers/gcp/tofu/gcp-engine.backend.ts).
Their presence in source does not extend the live evidence above. The current DNS
engine also needs its own installed lifecycle evidence, as noted near the top.

GCP releases can also run without a local checkout using a verified GitHub
connection for the selected repository. Hypervibe resolves the deployment branch
(or requested revision) to one commit, downloads that commit's archive, and sends
the bytes through the existing private upload path. Cloud Build runs inside the
archive's validated wrapper directory and never receives the GitHub API token or
download URL. Missing repository access blocks before a build; there is no
anonymous clone fallback. AWS and Azure still require a local checkout.

Source downloads are bounded to 128 MiB compressed and 512 MiB expanded, with a
60-second deadline. Archives with multiple roots, unsafe paths or links containing
parent-directory traversal are rejected without local extraction. These controls,
the public deploy path and serialized Cloud Build request have offline regression
coverage; authenticated remote-source builds have not been run against live GCP.
See [GitHub's archive API](https://docs.github.com/en/rest/repos/contents#download-a-repository-archive-tar)
and [Cloud Build working directories](https://docs.cloud.google.com/build/docs/build-config-file-schema#dir).

The original follow-ups included Google OAuth client registration, database
password rotation without downtime, import, shared state across machines, retained
project/image cleanup and shorter connection guidance. This page does not certify
their current completion status or set their priority. Use the
[common user journey](development/user-journey.md) to decide scope, and record new
implementation and live evidence against the exact affected step.
