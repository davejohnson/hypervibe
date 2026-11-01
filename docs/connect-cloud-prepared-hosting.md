# Installer-prepared hosting handoff

This draft extends the existing deployment connection, plan/apply loop and managed
CI. It does not establish live provider compatibility. Native GCP installation,
session issuance and first-release proof have offline contract coverage; Azure's
reviewed namespace installation and prepared runtime handoff also have offline coverage. No disposable-account first-release
walkthrough has run for this handoff.

An administrator may prepare exact hosting resources before the developer has a local
environment. The versioned deployment receipt records project lifetime and observed
parent, registry lifetime/ownership, and each workload's native identity, lifetime,
ownership, immutable holding image, holding principal and configuration digest.
Referenced secret containers can additionally retain exact native IDs and lifetime
evidence. The provider requires complete unique reference coverage when native names
and version numbers can recur after deletion; versions alone cannot pin a container.
The holding principal is separate from the application runtime and both deployment
principals. The provider parses its own native paths and coordinates. A generic string
schema alone never proves cloud ownership.

## Provider contract matrix

| Hosting provider | Native identity and completion contract | Prepared handoff status |
| --- | --- | --- |
| GCP Cloud Run | Exact project number/create time/observed parent; registry create time; service UID, original holding revision/generation, reconciliation state and terminal condition. Resource name alone is reusable. Holding creation and IAM are separately reviewed installation actions. | Shared and native installation/session/handoff/first-release contracts implemented with offline evidence; see [native evidence and prerequisites](connect-cloud-gcp-deployment-evidence.md). Live walkthrough and operator holding-image publication remain gates. Initial billing uses a separate reviewed reserved-project assignment; unsupported ancestry and cron remain explicit. |
| AWS ECS | Exact account/region/cluster/service ARN plus creation evidence and deployment state; IAM RoleID separately pins runtime identities. Service-list failures cannot establish absence. The installer does not pre-create workloads. Ordinary hosted apply creates a secret-free bootstrap; the exact-image CI release attaches the reviewed application references and task role. | Optional receipt absent preserves the existing path. Prepared handoff explicitly undeclared. |
| Azure Container Apps | Exact subscription/resource group/ARM resource ID plus native creation metadata and terminal deployment provenance; reusable ARM names are insufficient. PUT is create-or-update, requiring explicit reviewed namespace authority rather than an atomic-create claim. Original holding revision and container-inaccessible managed identities constrain first release. | Native installation, prepared handoff, final configuration and read-only release-target enrollment have offline coverage; see [Azure evidence](connect-cloud-azure-evidence.md). An approved disposable-account walkthrough remains outstanding. |
| DigitalOcean App Platform | Existing adapter only; no installer-prepared lifetime/holding contract reviewed. | Undeclared. |
| Fly | Existing adapter only; no installer-prepared lifetime/holding contract reviewed. | Undeclared. |
| Railway | Existing adapter only; no installer-prepared lifetime/holding contract reviewed. | Undeclared. |
| Vercel | Existing adapter only; no installer-prepared lifetime/holding contract reviewed. | Undeclared. |

The independent native references are the [Cloud Run Service resource](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.services),
[ECS DescribeServices](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_DescribeServices.html),
[Azure Container Apps GET](https://learn.microsoft.com/en-us/rest/api/resource-manager/containerapps/container-apps/get?view=rest-resource-manager-containerapps-2025-07-01)
and [Azure create-or-update](https://learn.microsoft.com/en-us/rest/api/resource-manager/containerapps/container-apps/create-or-update?view=rest-resource-manager-containerapps-2025-07-01).
These published response contracts define evidence to inspect; they do not independently
authorize adoption or prove the whole workflow was exercised live.

## Local lifecycle and recovery

The existing isolated project-binding stage creates the first local environment only
after provider verification. The new `hosting-prepared-bindings` stage then re-observes
the native receipt and records exact workload/registry bindings through one confirmed
metadata action. It has no provider mutation method. An unchanged proof is a metadata
noop. Unknown reads, conflicting retained identities, pending native attempts and
retained provider transitions block; the existing checkpoint and prerequisite stages
keep priority. A source revision, cancellation or local binding change during an await
invalidates apply authority. A lost repository export retains the exact SQLite proof;
retry can only re-verify and export that same reviewed state.
The final SQLite update compares the complete expected binding state in an immediate
transaction; a competing update after native observation cannot be silently overwritten.

`preparedHosting` retains installation/plan/receipt digests and a per-workload
`pendingFirstRelease` list. When present, `firstReleaseConfigurationDigests` covers
exactly that list. For hosted managed CI it hashes reviewed nonsecret desired configuration and
immutable secret references, never submitted secret values. A changed desired configuration needs
a new metadata plan before replacing its expected digest. Reading or importing an older
repository export cannot reinstate a completed first release or silently replace local
authority. The strict journal survives export even when workload names contain words
such as `token`; arbitrary payload fields remain rejected.

Binding preparation does not mark the app deployed. Native first rollout must atomically
replace the holding image and principal with the candidate application image, final
runtime identity and reviewed configuration/references. Until that exact native state and
release/source evidence are verified, the journal remains pending. Clearing it is another
explicit metadata action. Holding code must never receive application secrets as an
intermediate configuration step. Hosted GCP cron/release-command support and broader
storage or database provisioning require separate native lifecycle evidence. Local
operator release commands have the separately reviewed path below.

## Local first-release migrations

An empty database exposed a different path from an already initialized app:
prepared direct deployment returned success after updating the service without
running its declared release command. DG-050 independently requires the candidate
schema command to succeed before runtime changes. Five reconstructed native HTTP
cases failed before the correction, including missing execution, failed execution
and lost create/run acknowledgments. A worker-ordering case and two executed
generated-program completion cases also failed. The latter exposed a separate
reader that treated a terminal `Completed` condition as still running.

The first-release action now pins the command hash alongside image, native resource
lifetime and reviewed private configuration. It creates the exact migration job
with the final runtime account and references, one task, zero retries and a
one-hour timeout. The [Run API](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.jobs/run)
returns an operation; that operation must resolve to the exact immutable
[Execution](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.jobs.executions).
Its task configuration, account, command, image, task counts and terminal success
are verified before rollout. [Task retries](https://docs.cloud.google.com/run/docs/reference/rest/v2/TaskTemplate)
are a presence-sensitive union with default three: missing `maxRetries` does not
prove zero. The v1 ExecutionStatus documents `Completed`; v2's string discriminator
and condition-state contract are reconstructed together in offline fixtures,
pending the native walkthrough.

The existing private first-release journal records each attempted mutation and
acknowledged identity. After restart, a new confirmed continuation can observe
the original acknowledged operation and finish rollout without another job create
or execution. Unacknowledged creates/runs stay blocked; same-name resources are
never adopted as proof. Failed execution is retained for investigation, not
automatically rerun or deleted. Task resources remain recorded for recovery and
separately reviewed cleanup. A permission change during the absence check now
stops before creation; that boundary regression also failed before correction.
Workers explicitly depend on the migration-owning service. A lost service reply
can be recovered only with the original successful execution and matching native
application configuration. Normal tests exercise the actual SQLite planner,
apply, bootstrap, export and read-only recovery paths.

The following seed task reuses the recorded migration Job only while its original
workload and Job lifetimes still match. The independent
[Job contract](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.jobs)
defines the native UID and update fingerprint; the Run API also accepts an `etag`.
A reconstructed replacement with the same name first caused an unauthorized
PATCH in the regression. A second regression showed the seed run omitted its
execution precondition. Both now pass: the update checks the retained UID and
current fingerprint, and execution uses the freshly verified fingerprint. The
successful migration-to-seed boundary runs through the real adapter and serialized
transport. This is offline evidence; native migration and seed remain pending.

The approved disposable host's first deployment on 2026-11-01 exposed a real
producer/consumer mismatch before any migration Job or service update: planning
marked native references `preparedReleaseBinding`, but apply's strict metadata
schema rejected that exact marker. Backup retention had already increased to
eight; the dependent app, migration, seed and reference acceptance were not run.
The actual SQLite plan/apply regression reproduced the same authorization error
before the correction. It now exercises an immutable native reference together
with the migration and both first service revisions. Inline and native-reference
acceptance share the same completed-plan and fresh native-release proof. The
marker cannot authorize a reference write, unknown metadata remains rejected,
and post-release drift blocks without another service PATCH. Final acceptance
stores only reference ownership metadata, not the temporary release marker.
These passing regressions do not establish a successful resumed live release.

The generated Cloud Run execution reader uses the same completion interpretation.
Provider renderer revision 3 requires a new workflow-publication review; historical
revision-2 fingerprints remain in compatibility tests, while AWS/Azure legacy
program bytes remain unchanged. This does not silently update accepted workflows.
The named hosted installers for AWS, Azure and GCP still explicitly reject
migration-bearing source placement. This local operator fix does not extend those
hosted grants or claim native compatibility for another cloud. DigitalOcean, Fly,
Railway and Vercel have no declared prepared direct-release capability.

The pending-clear action reuses the existing scheduled-release provenance boundary:
the exact managed workflow files, current source commit, successful native GitHub run,
first attempt, uniquely correlated artifact and trusted v4 release validator must agree.
The artifact's immutable image and exact resource IDs are passed to the provider only
after verification; the provider still checks original lifetimes, final principal,
readiness and the previously approved configuration digest. Missing GitHub access or
evidence leaves the first release pending and does not block initial resource binding.
A changed run or source invalidates the reviewed completion action. Its saved prior
marker permits exact verification/export recovery after SQLite committed completion
but the repository export failed. It does not fabricate release provenance from current
desired state. GCP direct first releases use the distinct native-direct completion evidence described below; it does not substitute a managed-CI artifact or hosted grant.
The producer target resolver also receives that exact project/environment's reviewed
prior marker during recovery. Merely restoring an observation object was insufficient:
the resolver otherwise read the newer SQLite marker and changed the semantic hash.
This override is internal and read-only; ordinary compilation still uses current state.

## Observed regression evidence

The challenged assumption was that knowing native names was enough to reuse a prepared
workload. A first local environment instead planned service creation and lacked the
reviewed metadata boundary: three real SQLite/spec/planner/apply tests failed before the
new stage. Strict prepared receipts initially failed two boundary tests; native paths,
principal separation, cardinality, immutable images and extra fields now have shared
regressions. Native semantics in these shared tests are explicitly synthetic.

Seven further failing repository tests reproduced stale first-release reinstatement,
changed installation/configuration authority, permissive payloads and lost exported
hashes. A separate failing test showed that losing the authenticated prepared capability
could fall through to ordinary service creation; it now blocks while retaining history.
A SQLite counterexample also reproduced a competing binding write after the last native
read being overwritten and reported successful; atomic compare-and-swap now rejects it.
The normal test gate also covers confirmation, no native writes, unknown/replaced native
identity, cancellation/spec/binding changes during verification, checkpoint priority,
pending recovery, exact export retry and reviewed configuration/progress changes.
Two native run-provenance counterexamples failed before correction: a valid list summary
without `run_attempt` prevented completion, and a rerun starting after artifact observation
was accepted. Fresh exact run-detail reads now establish the attempt at both boundaries.
Existing schedule-activation regressions execute the emitted v4 artifact producer and
trusted validator; shared metadata tests use explicitly synthetic verified-release inputs.
An additional real SQLite regression runs the emitted Azure producer and shared artifact
validator before and after pending completion. It failed after completion until the
target resolver used the reviewed original inputs, then passed without changing stored
bindings; cross-project and cross-environment recovery inputs are rejected.
Registry conformance pins all seven hosting providers and requires a native parser for
every declared capability. Passing these tests proves these boundaries only; native
installation and runtime release have separately named reconstructed transport suites,
and approved disposable-account walkthroughs remain their own acceptance gate.

## Operator holding container

`templates/cloud-holding` contains the reviewed minimal Node 24 image source. It
runs as a nonroot user, listens on the platform port, returns a fixed 503 response
and never reads application configuration, logs requests or makes outgoing requests.
The build context excludes the repository except this runtime file. The ordinary
test gate sends synthetic request values through a real HTTP listener and checks
the response does not reflect them. Its managed Node version remains tied to the
shared helper runtime contract.

A local Linux amd64 build and container smoke test passed on 2026-10-25. The smoke
test disabled networking, used a read-only filesystem, removed Linux capabilities,
verified the nonroot user and fixed response, checked empty container logs, and
removed the exact test container. This is local container evidence, not native
registry pull or hosting evidence. The local image ID was
`sha256:2a19c8f7b32ff3ca239628e95772de64484b093f1a6746ce815af1b324845f9c`;
it is **not** a published registry manifest digest and must not be used as one.

Publication still needs owner approval. Publish to the reviewed public operator
registry, observe its immutable manifest digest and anonymous pull availability,
then configure that exact reference in Hypercloud. No image was published or
configured in a live environment by this change.

## Local inline configuration custody

The local operator first-release path also accepts managed runtime inputs through
the encrypted plan boundary. Its expected configuration digest can therefore be
an offline verifier for a guessed inline secret. Unlike hosted reference-only
digests, local first-release digests and direct attempt/completion journals remain
in authoritative local recovery state. Repository export retains native resource
identities and pending workload names but omits those private fields. Repository
replay preserves the local journals and cannot supply replacement recovery
authority. Shared command output redacts configuration digests and the enclosing
binding fingerprints before either MCP or CLI rendering.

Five actual file-export/import and shared command-boundary tests failed before
this correction; the focused 63-test group passes afterward, including existing
hosted reference-only round trips. The independent requirement is the existing
architecture rule keeping secret acceptance verifiers local. The counterexample
uses a digest of a four-digit synthetic value; removing plaintext alone did not
prevent an offline guess check. These are local custody tests, not cloud delivery
or native first-deployment evidence.


## Guarded local and hosted GCP direct first release

A local holding receipt is loaded from its accepted SQLite installation journal,
then checked against the exact current application/environment and native resource
lifetimes. Its shared descriptor contains preparation facts only. It creates no
hosted deployment connection, token exchange permission, CI authority or release
artifact. Hosted preparation retains its independent connection/source checks.

The ordinary saved-plan executor now passes a durable direct-release control
through bootstrap and orchestration. Only a current confirmed `service:<name>`
action can create its exact attempt, immediately before PATCH. Definite rejection
needs a fresh plan naming that rejected attempt. Attempted/uncertain writes cannot
be replayed. Fresh native image, final principal, original service UID, complete
runtime configuration and converged revision/generation establish completion;
SQLite retires only that workload in the same compare-and-swap as its binding.
A lost acknowledgment can be reconciled through a read-only metadata plan without
resupplying delegated secrets. That recovery preserves the prior reviewed inputs
for remaining workloads. A completed image-selector-only diff becomes noop only
with the same exact freshly verified native evidence; unrelated drift stays an
update.

First-release review and execution share the existing bootstrap runtime-input
projection, including database/cache values, service aliases, queues and storage.
Generated values are stable and are re-derived at apply; delegated values remain
frozen in the existing encrypted saved plan. Only the reviewed candidate revision
receives these values. The coordinator omits its preliminary environment-variable
write for this guarded transition. Follow-up managed-secret actions independently
verify all exact completed revisions and live value hashes, then record acceptance
without a redundant provider write. Native secret references remain immutable and
version-bound; their values are never materialized by this resolver.

Observed RED counterexamples included a missing durable attempt permitting PATCH,
a replaced original holding revision, raw-spec configuration digests rejecting
resolved secret/component inputs, release metadata corrupting a runtime-identity
action's authority, the legacy preparation flag blocking a verified local handoff,
pre-sync trying to configure the holding image, redundant post-release secret
writes, and lost-acknowledgment continuation attempting the already completed image.
The actual SQLite/PlanService/executePlanApply regression now covers metadata,
runtime binding, both web/worker first revisions, missing confirmation, encrypted
input freezing, stable generation, native recovery without resubmitted input and
one PATCH per workload. A two-observation race regression reproduced a generated value disappearing after its first verification and triggering two extra secret PATCHes; acceptance now blocks with zero additional writes. The integrated six-suite group passes 86 tests, and the adjacent plan/secret/custody/rollback checks pass (the legacy bootstrap prerequisite-order regression was retained and corrected). Native transport responses are reconstructed from the
published Cloud Run Service contract; they are not live compatibility evidence.
The existing hosted transport suite separately covers its authority path, while
AWS and other undeclared prepared capabilities remain outside this change.


## ECS ordinary first-release boundary

ECS does not declare the optional installer-prepared handoff. Its existing hosted
installation supplies separate task, execution and infrastructure roles, while
ordinary apply creates the Express service and managed CI releases the application.
The execution role is used by ECS; the bootstrap has no task role, application
values, native secret references, environment files, additional containers or
mounts. An existing local-key connection keeps its separate legacy behavior.

The challenged assumption was that an immutable Secrets Manager reference could
safely be configured before the application image. AWS documents that the value
is injected when that container starts. The real SDK create regression first
failed three assertions: the generic bootstrap received a native reference, an
inline application value and the final task role. Executed generated-release
regressions then showed missing final references/command/role, accepted native
replacement and missing final reference. Additional RED checks covered unexpected
mounts/volumes and final environment/command drift.

Installed runtime inspection and release enrollment admit only the exact owned,
lifetime-pinned secret-free bootstrap for the temporary missing task-role case.
Reapplying it is read-only and remains pending an application release. Declared
hosted runtime secret slots need immutable Secrets Manager destinations; inline
credential updates are unsupported. The first release adds the reviewed references,
final task role, command and configuration with the registry-returned image digest,
then verifies native identity and final configuration. Existing runtime identities
are preserved, and an uncertain create is never adopted or replayed by name.

Only immutable references and identities enter generated workflow declarations.
Nonsecret environment values come from the exact workflow source already verified
by the release broker, in process memory. A real SQLite/managed-target regression
first demonstrated environment-value changes rewriting workflow locks; it now
keeps those locks stable. The default GCP/Azure broker program bytes remain equal
to source `584342e`; ECS alone opts into retaining the verified source during the
release. Its provider renderer revision is 2, requiring normal workflow review.

Independent contracts: [ECS secret injection](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/secrets-envvar-secrets-manager.html),
[Express creation](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_CreateExpressGatewayService.html),
[Express update](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_UpdateExpressGatewayService.html).
These regressions use reconstructed serialized AWS responses and execute emitted
JavaScript. They do not establish a live AWS first deployment, successful runtime
secret retrieval, or hosted browser compatibility.

### Reference acceptance after application release

A freshly observed workload may declare `runtimeSecretReferenceActivation:
application-release` only after the provider verifies its exact bound identity,
lifetime, installation ownership and runtime roles. This is sequencing evidence,
not secret configuration evidence. For ECS it additionally verifies either the
strict secret-free bootstrap or the installed final task role. Missing or
unknown native proof blocks observation. Native version equality still comes
only from independently read task-definition references.

The named hosting matrix above remains exhaustive: installed ECS uses this
mode; Cloud Run and Azure retain their separately verified prepared/direct
release mechanisms; DigitalOcean, Fly, Railway and Vercel do not declare it.
Existing local-key ECS behavior is unchanged. Shared planning uses this native
observation contract without branching on a provider name.

Reference acceptance uses the existing post-release dependency mechanism. It
does not block the infrastructure-applied marker needed by the first CI run,
but it depends on the exact managed release and then performs read-only native
verification. The initial CI binding stage defers reference acceptance until
replanning. The mode is never persisted as accepted-reference evidence. A stale
plan, changed ownership, missing reference or unsupported release authority
cannot authorize an acceptance or a separate reference write.

An initial CI identity stage omits secret acceptance actions. Its exact service
create retains the reviewed immutable `creationSecretReferences`; apply compares
them with current desired state and requires every exact confirmed create. Any
already-bound service must already match. This retains existing create-only
authority without authorizing later reference writes or inventing acceptance.
ECS and Cloud Run can use their existing conditional creation; Azure does not
claim this contract and keeps its prepared lifecycle.

Observed lifecycle evidence: the actual SQLite/PlanService/executePlanApply
fixture first failed because the release-activation observation was absent. A
second initial-CI case failed because the filtered identity stage had discarded
its reference authority. Both pass after the fixes. The composed application
cycle now orders marker, emitted AWS exact-image release and read-only reference
acceptance, using one reconstructed AWS SDK transport. Separate tests construct
the real managed marker/release actions. GitHub lifecycle responses in the
composed execution fixture are explicitly synthetic; native GitHub provenance
has separate existing contract tests. Denied release, lost native release ACK,
replanning, replaced lifetimes, denied reads, missing references, altered mode
and missing/mismatched creation authority retain unaccepted references.

The focused AWS/application/shared group passes 404 tests across 27 files, and
TypeScript checking passes. These tests are in ordinary Vitest discovery; the
committed acceptance workflow runs `npm test`, and desired repository policy
requires `Hypervibe / acceptance`. Live branch protection was not inspected by
this change. No live ECS deployment was performed.

**Shared CI recovery:** the original GitHub dispatch path could repeat a release
after losing its acknowledgment, especially with `forceRelease`. The separate
[managed dispatch recovery change](managed-release-dispatch.md) now retains
intent before the request, recovers an exact run without dispatching again, and
requires actual v4 release proof before dependent acceptance. These are offline
regressions; live first-release walkthrough evidence remains a separate gate.

Independent review found that task `entryPoint` and `healthCheck` overrides could
survive the bootstrap image replacement and execute with final application
authority. AWS documents both fields as executable container configuration in
[ContainerDefinition](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_ContainerDefinition.html).
Four emitted-native cases failed before restriction (unsafe bootstrap and final
readback for both fields). Ten additional initial-bootstrap cases failed for
user, working directory, privilege, Linux capabilities, hosts, system controls,
security options, limits, credential specifications and FireLens configuration.
Initial bootstrap validation now rejects those unreviewed inherited overrides;
empty lists and false native boolean defaults remain allowed. This does not
remove reviewed settings from ordinary existing local-key workloads. Final
installed release verification independently rejects executable entry-point or
health-command drift. Shared CI recovery is documented separately above.


The legacy emitter compatibility check caught an additional regression: installed
ECS changes leaked an extra internal return field and blank lines into the
local-key renderer. Its frozen main-branch SHA-256 failed before the correction;
the legacy bytes are now restored exactly without updating the fixture hash.
The provider revision assertion separately freezes the old ECS revision 1
semantic contract and requires review of revision 2. The focused legacy and
emitted ECS task-definition suites pass 31 checks; this is offline compatibility
evidence, not a live AWS deployment claim.
