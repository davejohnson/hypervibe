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
| Web services | yes | yes | yes |
| Background workers, on-demand workers | yes | yes | yes |
| Scheduled jobs | yes | yes | yes, UTC schedules only |
| PostgreSQL, testing environments | yes | yes | yes, one shared server per project |
| Production-shaped environments | yes: dedicated database, deletion protection, 14 daily backups, 7 days point-in-time recovery | blocked (#625) | blocked (#625) |
| Database size (`database.size`), deletion protection | yes | blocked (#625) | blocked (#625) |
| File storage | yes (`gcs`) | yes (`s3`) | yes (`azureblob`, native access only) |
| File versioning (30 days), browser uploads straight to storage | yes | blocked (#664) | blocked (#664) |
| Always-on web service (`alwaysOn`) | yes | blocked (#625) | blocked (#625) |
| Redis | yes (`memorystore`) | blocked (#628) | blocked (#628) |
| Queues | yes | blocked (#628) | blocked (#628) |
| Custom domain | yes, DNS-only records | blocked (#606) | blocked (#606) |
| Buying a domain | blocked (#627) | blocked (#627) | blocked (#627) |
| Generated and outside secrets | yes | yes | yes |
| Private package build token (`npm_token`) | implemented; private-package live run unverified | implemented; native request, generated command and configuration verified; live run unverified | implemented; ACR task request and configuration verified; live run unverified |
| Migrations as a release step | yes (`releaseCommand` mode) | blocked at release | blocked at release |
| Daily backups, restore drills | blocked (#253) | blocked (#253) | blocked (#253) |
| Promotion and promotion tests | blocked (#252) | blocked (#252) | blocked (#252) |
| Email, webhooks, iOS releases | blocked (#626) | blocked (#626) | blocked (#626) |
| Database resilience, seed command, credential aliases | blocked | blocked | blocked |
| Spend alerts | not built (#629) | not built (#629) | not built (#629) |

## Read-only workload diagnostics

AWS and Azure engine service logs and deployment health are implemented with
normal-CI transport and public-command checks, but have no live validation yet.
They use exact state-derived workload identities; worker/job-only health does not
require an HTTP endpoint. See [engine diagnostics](../engine-diagnostics.md) for
native coverage, log windows, pagination bounds and execution-history limits.
Build-log and deployment-history listing remain unavailable on these engines.
GCP and Railway retain their existing observation paths and evidence status.

## Rules for changing this page

- A capability moves to `yes` only with its admission check, a boundary
  regression and, for a support claim to users, recorded live evidence.
- Unsupported desired state must be refused before any effect. A capability that
  is neither built nor refused is a defect.
- Build a capability once behind a cloud-neutral interface; each destination
  implements it or is listed here as `blocked`.
