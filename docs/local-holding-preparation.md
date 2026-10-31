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

### Observed service scaling during holding recovery

On 2026-10-27 the approved test service completed creation with native service
`scaling.maxInstanceCount: 20` and revision `template.scaling.maxInstanceCount: 1`.
Hypervibe incorrectly assumed any nonempty service scaling changed the reviewed
holding configuration. Google's [maximum-instance contract](https://docs.cloud.google.com/run/docs/configuring/max-instances)
specifies the lesser maximum; this response preserves the reviewed revision cap.
The sanitized native field projection is pinned in
`test/provider-contracts/gcp/holding-service-observation.json`. Identity strings,
labels and etag are replaced; configuration values and omitted defaults remain.
The observed value 20 is not assumed to be a universal provider default.

Before the fix, the real application/SQLite recovery and executed generated-CI
checks failed five cases; four additional projection cases failed. The shared
holding interpreter now accepts only automatic service scaling with a zero floor
and valid nonnegative integer maximum, while retaining the exact revision cap,
identity, readiness, traffic and inert-container checks. Manual scaling, added
fields, nonzero floors and altered revision maxima remain rejected. All 90 focused
checks pass in normal `npm test`. This validates recovery interpretation across
local and hosted setup, observation and emitted first release; it does not establish
live application rollout or all-cloud onboarding. Maximum instances are not an
absolute spending ceiling and Google documents temporary exceedance under load.

The corrected packaged library subsequently recovered the actual web operation
without another create, completed the two remaining approved actions, and verified
all six native holding actions. Public invocation is limited to the web service;
the worker remains internal. This proves the inert prerequisite on this disposable
project, not application startup, OAuth exchange or secret collection.

The same walkthrough challenged guidance that treated every pending receipt as
requiring another user approval. Four command/SQLite regressions failed before the
change, followed by three cases including native `skipped_noop` receipts. Explicit
suggested read-only recovery now continues for pending-only outcomes; failures,
blockers, confirmation skips, unknown states and mutation follow-ups still stop.
Holding recovery points to `hv_plan`, which reconciles its retained journal before
ordinary application bindings exist. All 64 focused guidance checks and typecheck
pass. This adds no write authority and never permits replay of an uncertain write.

### Repository export and restart

The 2026-10-27 disposable walkthrough also disproved the assumption that a
sanitized repository receipt could replace its authoritative local copy. The
completed six-action journal still reproduced the original receipt digest and
native identities, but both retained workload declarations lacked
`runtimeSecrets: []`. The repository sanitizer removes secret-shaped keys, and
array replay replaced those declarations wholesale. Adding only secret
destinations therefore encountered the holding prerequisite again. The observed
bindings were already stripped before that spec update; the update itself did
not change their identities.

An actual command/SQLite regression reproduced export, restart, repository
hydration and the blocked narrow plan before the fix. Separate failing cases
showed rejection of the observed older shape and acceptance of replacement or
newly imported local receipts. The local receipt now stays out of repository
exports; an older sanitized copy can only match and preserve retained local
authority. New-environment hydration uses the same merge guard. Verification
can reconstruct omitted empty runtime declarations only when the completed
journal proves them and the original receipt digest, native IDs, lifetimes and
ownership still match. It never infers nonempty secret references, rewrites
stored state, or accepts a different receipt.

The normal acceptance cases exercise both narrow destination planning and full
operator-output prerequisite planning after restart, as well as changed IDs,
ownership, digest and nonempty-reference rejection. These are reconstructed
local lifecycle regressions with serialized synthetic cloud transport; they do
not establish another live installation or successful application deployment.
They run through ordinary `npm test`, which both committed acceptance CI and
desired required-check configuration select; this alone does not verify live
branch-protection enforcement.

### Empty native domain inventories during first deployment

A native 2026-10-31 read returned HTTP 200 with `kind: DomainMappingList`,
`apiVersion: domains.cloudrun.com/v1` and `metadata.selfLink`, omitting `items`.
The assumption that every successful list includes an explicit array marked the
entire hosting observation partial and blocked unrelated immutable references and
generated application secrets. Google's [domain-list contract](https://docs.cloud.google.com/run/docs/reference/rest/v1/namespaces.domainmappings/list)
and the redacted native field projection establish the counterexample. One actual
Cloud Run adapter/serialized-HTTP regression failed before correction; 41 focused
observation, first-release and reference checks plus typechecking pass afterward.

The shared domain inventory reader now accepts omitted items only with the exact
list kind and API version. Missing/wrong envelopes, explicit malformed items,
unreachable locations and malformed pagination metadata remain unknown. It changes
no other provider's observation contract or mutation authority. The read-only live
diagnosis establishes this parser failure; deployment, runtime reader grants and
native backup/restore remain separate acceptance requirements. A prior local test
guard also omitted this namespace-style GET; correcting that guard alone did not
resolve the product failure.

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
