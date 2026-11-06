# OpenTofu infrastructure engine (GCP pilot)

Status: **exploration branch** (`feat/opentofu-gcp-engine`). Nothing here is on a
user's default path yet; existing GCP lifecycle code is unchanged.

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

## Next steps (in order)

1. **Wire into `hv_plan`/`hv_apply` behind an explicit opt-in.** Add an engine
   lifecycle registration to the provider registry; in plan, build
   `GcpCloudRunEngineInput` from the spec and bindings (resource names, runtime
   identity, built image digest, secret references), call `OpenTofuEngine.plan`,
   persist the segment with the plan run, and surface blockers. In apply, pass a
   `segmentHandler` that calls `OpenTofuEngine.apply` under the environment lock.
   Turn off the old Cloud Run service writer for opted-in environments.
2. Distribute the pinned binary: download to `~/.hypervibe/engine/bin`, check
   against `OPENTOFU_ARCHIVE_SHA256`, never upgrade silently.
3. Secret Manager reference wiring through the approved secret workflow.
4. CI writer: limit to image and release metadata, add the etag guard.
5. Live Cloud Run journey on a new environment (needs your approval for billable
   creates): connect → create → deploy → health → newer image → infra change →
   image preserved → noop → concurrent CI release + apply → approved teardown.
6. Cloud SQL, then GCS / Memorystore / Pub/Sub / jobs, then import of the existing
   sites, then shared state for multiple machines.
