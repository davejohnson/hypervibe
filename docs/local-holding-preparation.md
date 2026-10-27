# Local holding preparation

Design recorded before implementation. An operator needs the provider-assigned
HTTPS origin before registering browser redirects. Missing application OAuth
credentials must not require running application code or copying administrator
credentials into a workload to obtain that origin.

`hosting.preparation: {kind: "holding-v1", image: "…@sha256:…"}` selects an
isolated spec/plan/apply prerequisite after the exact local project and registry
are bound. The declaration selects immutable, already published holding bytes;
it does not build or publish them. Every native identity, service create and
public invoker grant has its own confirmed action and retained attempt. The
existing local administrator actor stays separate from all hosted actors.
Nonsecret evidence uses the existing SQLite run journal in a distinct namespace.

| Hosting provider | Local holding prerequisite | Existing hosted preparation |
| --- | --- | --- |
| Cloud Run | Scoped Google user ADC; parentless, journal-owned project | Separate administrator-installed receipt |
| ECS | Explicitly unsupported | Separate CloudFormation installation |
| Azure Container Apps | Explicitly unsupported | Separate ARM installation |
| Railway | Explicitly unsupported | No shared prepared receipt |
| Fly.io | Explicitly unsupported | No shared prepared receipt |
| DigitalOcean App Platform | Explicitly unsupported | No shared prepared receipt |
| Vercel | Explicitly unsupported | No shared prepared receipt |

The local receipt never becomes a hosted deployment connection. Shared prepared
resource inspection and first-release transitions accept independently validated
local journal authority or the existing hosted authority. Holding readiness is
reported as prepared/inert, never application health. All declared web/worker
resources are prepared together because the shared binding contract requires
complete topology; cron remains unsupported. Inert containers have zero minimum
instances, maximum one, request CPU and no environment, secrets, mounted data,
network connectors or application commands. A distinct final runtime identity
starts without grants. Normal worker CPU/floor requirements apply on release.
The retained billing account is shown in the cost review and compared with fresh
native billing information before every preparation phase; enabled billing alone
does not authorize a different payer. Google does not provide a cross-service
transaction locking the billing association and service creation together.

Application image, configuration, final identity and runtime IAM are a later
review. Direct release requires exact native current revision, image and final
identity proof and transactional retirement of pending first-release metadata;
it must not invent managed-CI provenance. Source changes or uncertain native
outcomes preserve read-only recovery and cannot authorize unstarted writes.

Independent contracts: [Cloud Run v2 create](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.services/create)
is a create operation returning an asynchronous operation, and [service identity](https://docs.cloud.google.com/run/docs/securing/service-identity)
is separate from the caller. Existing serialized provider contract fixtures are
reconstructed evidence, not live compatibility. New acceptance must exercise
the real spec/plan/apply and SQLite boundaries, native serialized transport,
missing secrets, exact confirmation, lost acknowledgments, restarts, replacement
UIDs, unknown observation, source revocation, zero-write noop and first release.

The normal application regression first failed at spec admission before this
capability existed. It also exposed a rejected-attempt retry dead end, a parser
that rejected native initial generation `1`, unexpected project IAM membership
for a final identity, and generic apply guidance that implied application
convergence. Additional counterexamples exposed completed holding/publication
stages incorrectly rejecting later deployment inputs and enabled billing on an
unreviewed account. Completed unchanged stages now reach ordinary native
inspection; an unavailable inspector still blocks, and changed or pending
preparation does not gain deployment authority. The resulting checks exercise actual command handling, saved-plan
confirmation, SQLite restart and native client serialization. Holding/final
identity membership is checked during preparation; later independently reviewed
final runtime grants do not invalidate the local receipt. Native replacement,
unknown reads, a foreign identity and lost authority fail closed. Lost account,
service and public-grant acknowledgments recover through reads without replay.
The synthetic responses establish those boundaries, not live Cloud Run support
or the cause of any customer incident. Direct first-release acceptance is recorded
separately by the shared prepared-hosting contract.

### Cloud SQL first release

The local operator path reuses Cloud Run's existing `cloudsql` volume and
`/cloudsql` mount for the resolved `CLOUD_SQL_CONNECTION_NAME` (or existing
`INSTANCE_CONNECTION_NAME` fallback). Prepared configuration, direct apply,
generated CI and independent native readback carry the same mount shape. The
prepared path admits exact connection names in the runtime service account's
project; cross-project SQL, private VPC routes and arbitrary extra mounts remain
unsupported here. Existing ordinary deployment behavior is preserved.

Google's [Cloud Run connection guide](https://docs.cloud.google.com/sql/docs/postgres/connect-run)
requires Cloud SQL client authority on the workload service identity; local
administrator sign-in cannot substitute for it. The existing runtime-access
plan/apply frontier now offers an explicitly confirmed project-level
`roles/cloudsql.client` grant to the journal-verified final account. It preserves
unrelated IAM and its etag, never grants the holding account, and verifies the
native policy before readiness. Unknown reads block. Acknowledged or uncertain
writes retain their exact pending attempt for read-only recovery; a failed
readback cannot become permission to resubmit. Grants and final runtime accounts
remain retained during local holding cleanup, as separately authorized runtime
access. This is connector authorization, not SQL password or live connectivity
verification.

The challenged assumption was that ordinary database input projection was
sufficient for prepared first deployment. Two independent serialized Service
cases showed a missing socket mount and rejection of a valid native mount.
Four real SQLite/shared-runtime cases then showed missing client-grant review,
no grant execution/recovery, and false readiness after a denied IAM read. All
were observed RED before runtime changes. Google documents the native shape in
[CloudSqlInstance](https://docs.cloud.google.com/run/docs/reference/rest/v2/Volume#CloudSqlInstance).
The normal acceptance cases now execute the generated readback, exact confirmed
grant, unchanged holding identities, lost acknowledgments, readback denial and
no-repeat recovery. An actual adapter deployment also remains blocked before
the grant, then verifies the serialized socket volume, final account, independent
native revision and local completion without retiring another pending workload.
Recovery also exposed a shared identity-attempt bug: apply
assigned a fresh ID to pending recovery; it now retains the original ID, matching
the existing storage-access recovery path. Focused GCP, ECS and Azure lifecycle checks
pass; these reconstructed transport tests are not live Cloud SQL certification.
