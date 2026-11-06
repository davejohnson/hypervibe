# OpenTofu infrastructure engine (GCP pilot)

Status: **pilot, opt-in per environment** (`hosting.engine: "opentofu"`). The
complete Cloud Run journey has been demonstrated live (below). Environments
without the flag use the standard lifecycle unchanged.

## Decision

Replace Hypervibe's hand-written GCP *resource lifecycle* code with OpenTofu and
the Google provider, one capability at a time, while Hypervibe keeps the product:
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

## What is built on this branch

| Piece | File | Evidence |
| --- | --- | --- |
| Cloud-neutral engine contract | `src/domain/ports/infrastructure-engine.port.ts` | Type-checked; nothing Google-specific |
| Process runner (no inherited env, timeout, SIGINT cancel, exact-value + pattern redaction, version pin check) | `src/adapters/engine/opentofu/runner.ts` | Live tests |
| Private durable state, per-state key in Hypervibe's secret store, enforced state **and** plan encryption, generated lock file, pre-apply backups, refusal to mint a new key for existing state | `src/adapters/engine/opentofu/workspace.ts` | Live tests |
| Saved plan → Hypervibe actions; unmapped addresses and `forget` block the plan; replace/delete require confirmation; apply events → per-address outcome | `src/adapters/engine/opentofu/plan-mapping.ts` | Unit + live tests |
| Plan/apply of the exact reviewed artifact (plan digest, config digest, engine + provider versions, full-approval check) | `src/adapters/engine/opentofu/engine.ts` | Live tests |
| Executor **engine segment**: one saved plan runs once; each action gets its own receipt; members report real outcomes even after an earlier failure; external prerequisites must complete first | `src/domain/plan/converge.executor.ts` | `engine-segment.executor.test.ts` |
| GCP backend: Cloud Run v2 service + public invoker, Secret Manager *references*, digest-pinned images, narrow image ownership, pinned Google provider 8.9.0 | `src/adapters/providers/gcp/tofu/gcp-engine.backend.ts` | Validated by the real provider |
| Read-only authentication check through a saved Hypervibe connection | `src/application/engine-auth-probe.ts` | Verified against a real project (below) |

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

Not yet proven: any create/update/delete of a real GCP resource through the engine.

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

Needed before enabling: the CI writer (`cloudrun-ci.workflow.ts`, the
`template.containers` PATCH) must change only the image and release metadata and
must use the service `etag` on every write, so a concurrent engine apply and CI
release cannot overwrite each other. If the live journey shows the provider cannot
hold this split safely, releases move into the engine instead.

## Findings about current behavior

- **Cloud Run runtime secrets are plain environment values today.** No GCP code
  writes Secret Manager references (`valueSource.secretKeyRef`). The engine backend
  supports references only. Moving a secret to a reference needs the existing
  approved secret workflow to create the Secret Manager secret and grant the runtime
  identity `secretAccessor`. That is a prerequisite for the first Cloud Run journey.
- The CI release writer replaces the whole container list from a fresh read. That is
  safe for field preservation but racy without an etag.

## Cross-cloud boundaries

Shared: runner, saved-plan handling, encryption, state layout, approvals, engine
segments and receipts. Per cloud: configuration, authentication, resource mapping.

- AWS and Azure must never need a Google account or GCS bucket for state. Local
  state is keyed by `provider/project/environment/partition`. A future shared
  backend is chosen per cloud (S3 for AWS, Blob for Azure, GCS for GCP).
- Secret Manager references stay inside the GCP backend.
- The Cloud Run CI image split is a GCP decision, not a model every cloud must use.

## Minimal user interaction (hard requirement)

Target journey for an existing cloud account: choose the cloud (or accept the
recommendation) → sign in and approve access → pick a billing account only if it
can't be determined safely → review the deployment and cost → get a working URL.
Project creation, API enablement, IAM, deployment identities, storage, secrets,
deploy and verification belong to Hypervibe. Payment verification and
organization admin consent may still need a person; Hypervibe links straight to
that step and resumes afterward.

The existing GCP bootstrap (`hv_connections action="bootstrap"`) already creates
the deployment identity used above. It still depends on local Application Default
Credentials for the one-time admin step; replacing that with a browser sign-in is
open work, and the first Cloud Run milestone must include it.

## GCP method disposition

Replace with the engine once the matching capability is proven live:

- `cloudrun.adapter.ts`: service create/update request construction in `deploy`
  (service spec, IAM invoker, VPC access, scaling), `deleteService`,
  `upsertCloudRunJob`/`upsertCloudSchedulerJob` and their delete/verify-deleted
  helpers, `ensurePublicInvoker`, `ensureArtifactRepository`.
- `cloudsql.adapter.ts`: instance/database create/update/delete and their polling.
- `gcs.adapter.ts`, `memorystore.adapter.ts`, `pubsub.api.ts`: resource lifecycle.

Retain (operational):

- Builds and image digests (`buildImageForService`, `submitCloudBuild`), release
  jobs and their execution, `runJob`, logs, deployments, `observe`, maintenance
  suspend/resume, domain mapping status, runtime identity checks.
- Cloud SQL password rotation, temporary access, queries, migrations, restore
  drills and recovery. Hypervibe stays the credential writer.
- GCS object transfer and data-deletion safeguards.
- `gcp-bootstrap.client.ts` (project, billing, API enablement, deployment identity).
  Moving parts of it into a project-shared engine state is a later, separately
  approved change.

## How it works for a user

1. `hv_spec` with `environments.<env>.hosting = { provider: "cloudrun", engine: "opentofu" }`.
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

Not exercised: CI releases (blocked for engine environments), concurrent
multi-machine execution, Cloud SQL, domains.

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

## Gap to the target experience

Target: install the MCP, say "deploy this web service and database to GCP with a domain",
sign in once, and get a working app. Remaining work, in order:

1. **Cloud SQL through the engine** (instance and database by OpenTofu; Hypervibe keeps
   password generation/rotation, connection wiring via the runtime identity, recovery).
2. **Custom domain** (Cloud Run domain mapping or load balancer by OpenTofu; DNS through
   the existing Cloudflare integration) with certificate readiness verification.
3. **One guided flow**: today the agent runs spec → bootstrap → plan → apply → deploy as
   separate calls. A single orchestrated "deploy" that stops only for sign-in, billing
   choice and cost confirmation.
4. **Sign-in without gcloud**: bootstrap still borrows local Application Default
   Credentials for the one-time admin step; replace with a browser OAuth flow.
5. **Private repositories**: builds clone the public git URL; private repos need a
   source upload or a Cloud Build repository connection.
6. CI releases for engine environments (etag-guarded image writer), scheduled jobs,
   storage, Memorystore, Pub/Sub; import of existing sites; shared state for multi-machine.
7. Teardown leaves the Artifact Registry images and the (empty) GCP project; decide
   whether "delete everything" should include them.
