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
| AWS ECS | Exact account/region/cluster/service ARN plus creation evidence and deployment state; IAM RoleID separately pins runtime identities. Service-list failures cannot establish absence. Existing ECS installation/apply path does not create holding workloads. | Optional receipt absent preserves the existing path. Prepared handoff explicitly undeclared. |
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
intermediate configuration step. New GCP cron/release-command support and broader storage
or database provisioning require separate native lifecycle evidence.

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
desired state. Direct deployments without managed-CI artifact evidence currently retain
the pending completion marker; that path has no equivalent completion proof yet.
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
