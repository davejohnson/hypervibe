# What Hypervibe supports today

This is the one statement of scope. It records what the planner admits for each
destination, taken from the engine admission checks in
`src/domain/services/infrastructure-engine-selection.ts`,
`src/application/infrastructure-engine-aws.ts` and
`src/application/infrastructure-engine-azure.ts`. Admission is not live proof:
recorded live evidence is in the [GCP](../opentofu-engine.md),
[AWS](../opentofu-engine-aws.md) and [Azure](../opentofu-engine-azure.md) engine
notes. The [user journey](user-journey.md) is the target; this page is the present.

Update this page in the same change that adds, removes or newly blocks a capability.

## Product scope

Hypervibe takes an app from prompt to a running website and mobile app on Google
Cloud, AWS or Azure through the managed OpenTofu engine, and then operates it:
secrets and their rotation, backups and tested restores, CI, promotion and
rollback, domains, and the common outside services an app needs (Stripe,
SendGrid, Cloudflare, GitHub, App Store Connect).

SendGrid Email Logs has a dated read-only receipt for one account search and
one exact-message timeline. Environment attribution and other account scopes
remain unverified. The domain, sender and webhook operations have separate
entries in `hv_inspect({})`; none has a live mutation receipt in this matrix.
[Read the bounded October 15 receipt](../../test/provider-contracts/sendgrid-email-logs.md#bounded-live-evidence).

Railway is frozen. It keeps working for existing apps and receives no new
capabilities. Nothing new may depend on it, and it is not listed below.

Out of scope and removed: GitHub Pages, the Cloudflare load balancer. Filesystem
volumes exist only on Railway and are not offered on the cloud engines.

## Capabilities by destination

`yes` means the planner admits it. `blocked` means the planner refuses it with an
explicit message. Capabilities no engine builds yet are refused by one shared list,
`commonEngineProblems`, so a new engine cannot silently drop them.

| Capability | GCP | AWS | Azure |
| --- | --- | --- | --- |
| Web services | yes | yes: always-on containers with an HTTPS address; built 2026-11-17, not yet run live | yes |
| Background workers, on-demand workers | yes | yes | yes |
| Pause one fixed-size worker (`workerPaused`) | yes, Cloud Run worker pool manual count | yes, ECS service desired count. Offline plan and CI release coverage | blocked ([#791](https://github.com/davejohnson/hypervibe/issues/791)) |
| Scheduled jobs | yes | yes | yes, UTC schedules only |
| PostgreSQL, testing environments | yes | yes | yes, one shared server per project |
| Managed database query and inspection | Cloud SQL connector; retained regression coverage, live query unverified here | Aurora Data API with environment app login; offline contracts and local SQL isolation regression, live unverified | Shared Flexible Server, exact environment database and private credential; offline contracts, live unverified |
| Production-shaped environments | yes: dedicated database, deletion protection; new databases start with 14 daily backups and 7 days point-in-time recovery; existing backup policy is preserved | blocked (#625) | blocked (#625) |
| Database size (`database.size`), deletion protection | yes | blocked (#625) | blocked (#625) |
| Shared database server (`database.placement: "app"`): each environment gets its own database on one server per app | implemented, opt-in, run live once on 2026-11-23 for create, second environment, rotation, teardown and server removal ([what that run did and did not confirm](../opentofu-engine.md#one-database-server-per-app-opt-in-2026-11-23)). Refused with a plain message for now: on-demand workers that count pending work, migration and `dataMigration`, direct queries, `database.size`, `database.version`, `deletionProtection: true`, moving an existing database onto it. Moving a database off it to a server of its own (remove `placement`; three confirmed rounds of plan and apply with a short full pause) is implemented and was run live once on 2026-11-25 on a two-table scratch app, all three rounds, with about two minutes of database errors during the switch; failure paths and larger databases have not been run live ([details](../opentofu-engine.md#moving-a-database-off-the-shared-server-implemented-run-live-once-2026-11-25)). The server itself is removed with `hv_plan scope="shared-database" intent="remove"` (two confirmed steps; run live once on 2026-11-23) | not available ([#831](https://github.com/davejohnson/hypervibe/issues/831)) | not available as a choice ([#831](https://github.com/davejohnson/hypervibe/issues/831)); testing environments already share one server |
| File storage | yes (`gcs`) | yes (`s3`) | yes (`azureblob`, native access only) |
| File versioning (30 days), browser uploads straight to storage | yes | S3 versioning, 30-day noncurrent expiry and signed uploads | Blob soft delete (30 days) and SAS uploads. All containers in an environment share these account settings. |
| Automatic storage tiering (`storage.<name>.autoTiering`, off unless set) | yes: Cloud Storage Autoclass, changed in place, coldest class Nearline, so files stay instantly readable. Kept beside versioning and its 30-day cleanup. Turning it on or off is reviewed as a cost change with its own approval. Offline verification, no live run | yes: a lifecycle rule moves files to S3 Intelligent-Tiering (automatic instant-access tiers only; the delayed archive tiers are never enabled). Offline verification, no live run | refused by the spec: last-read tracking is a storage account setting that every container in the environment shares, and Azure charges for reading cooled files |
| Copy a Railway database and Railway buckets into an environment and check the copy (`hv_migrate`) | implemented and tested offline (the real copy scripts against local PostgreSQL; stand-ins for Cloud Run, Secret Manager and Railway); not run live ([#870](https://github.com/davejohnson/hypervibe/issues/870)). While a copy job runs, its access to the source is held in a temporary secret the target app could read (accepted 2026-11-26, [data migration](../data-migration.md#railway-to-google-cloud)). Not yet: deleting the database export file after the restore, and a fresh comparison of a private Railway database | no | no |
| Always-on web service (`alwaysOn`) | yes | blocked (#625) | blocked (#625) |
| Redis | yes (`memorystore`) | blocked (#628) | blocked (#628) |
| Queues | yes | blocked (#628) | blocked (#628) |
| Custom domains | Primary `domain` plus `domains: [{ domain, dns }]` on the same public service. Each hostname selects a DNS-only zone and connection. | blocked (#606) | blocked (#606) |
| Buying a domain | reviewed Cloudflare purchase followed by Cloudflare DNS and Cloud Run attachment; offline coverage (#627) | blocked (#627) | blocked (#627) |
| Generated and outside secrets | yes | yes | yes |
| Secret limited to named services (`secrets.<KEY>.services`) | yes, as an access boundary: named services run as their own service accounts and other identities' project-wide Secret Accessor grants exclude the secret. Needs one administrator setup step before the plan, and a second after the apply when the secret already exists in the environment; until then it is reported as not enforced. Refused for an on-demand worker and with `gcpRuntimeSecretGrants`. Offline verification, no live run. | yes, as an access boundary: per-service IAM roles and a scheduler-only control role, in the environment plan. Offline verification, no live run. | yes, as an access boundary: per-service managed identities with per-secret Key Vault roles, in the environment plan. Offline verification, no live run. |
| Branch CI releases | implemented GitHub OIDC path; existing evidence retained | implemented, offline verification; live OIDC/build/release unverified | implemented with a dedicated environment build registry, offline verification; live OIDC/build/release unverified |
| Private package build token (`npm_token`) | implemented; private-package live run unverified | implemented; native request, generated command and configuration verified; live run unverified | implemented; ACR task request and configuration verified; live run unverified |
| Manual release without a local checkout | implemented for a verified GitHub repository connection; exact-commit archive and build request checked offline, live unverified | unavailable; local checkout required | unavailable; local checkout required |
| Migrations as a release step | yes (`releaseCommand` mode) | blocked in spec and planning | blocked in spec and planning |
| Daily backups, restore drills | blocked (#253) | blocked (#253) | blocked (#253) |
| Promotion and promotion tests | blocked (#667) | blocked (#667) | blocked (#667) |
| Email, webhooks, iOS releases | blocked (#626) | blocked (#626) | blocked (#626) |
| Database resilience, seed command, credential aliases | blocked | blocked | blocked |
| Spend alerts | not built (#629) | not built (#629) | not built (#629) |
| Remove Hypervibe's setup after every environment is torn down (`hv_connections action="remove-project"`) | deletes the Google project that setup created; offline verification | removes Hypervibe's user, roles, policies and GitHub sign-in from the account, keeps database snapshots; offline verification, not yet run live ([#827](https://github.com/davejohnson/hypervibe/issues/827)) | removes the project's resource group, Key Vault (purged), deploy app and roles; offline verification, not yet run live ([#828](https://github.com/davejohnson/hypervibe/issues/828)) |

## Read-only workload diagnostics

AWS and Azure engine service logs and deployment health are implemented with
normal-CI transport and public-command checks, but have no live validation yet.
They use exact state-derived workload identities; worker/job-only health does not
require an HTTP endpoint. See [engine diagnostics](../engine-diagnostics.md) for
native coverage, log windows, pagination bounds and execution-history limits.
For AWS and Azure, `hv_status` shows current workload activity when exact service
counts are available. Scaling a service to zero is distinct from a missing or
unreadable workload. Worker queue depth, next wake and database pause history
still need coverage.
Build-log and deployment-history listing remain unavailable on these engines.
GCP and Railway retain their existing observation paths and evidence status.

See [AWS and Azure branch releases](../engine-ci-releases.md) for setup, applied
binding admission, build isolation, workflow generation and live-verification
limits. This implementation needs a published package before generated workflows
can use its runner.

Database query/inspection evidence is documented in
[engine database access](../engine-database-access.md). Queries do not create
network access. Azure engine databases are closed to the internet, so queries
against them are refused until a private connector exists. AWS Data API supports bounded SQL and migration source
summaries; PostgreSQL socket data transfers remain blocked. Missing or ambiguous
accepted identity/state blocks access. Server inspection keeps SQL authentication
and running application credentials unverified.

## Rules for changing this page

- A capability moves to `yes` only with its admission check, a boundary
  regression and, for a support claim to users, recorded live evidence.
- Unsupported desired state must be refused before any effect. A capability that
  is neither built nor refused is a defect.
- Build a capability once behind a cloud-neutral interface; each destination
  implements it or is listed here as `blocked`.
