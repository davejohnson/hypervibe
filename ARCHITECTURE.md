# Hypervibe Architecture

Hypervibe helps vibe coders deploy and operate apps on Google Cloud, AWS and Azure.
It owns the DevOps journey; OpenTofu is the chosen infrastructure lifecycle engine.
This document defines the target architecture and the boundaries that implementation
must preserve. GCP selects the managed OpenTofu engine automatically. No legacy
GCP infrastructure writer or opt-in engine choice is supported. Implementation
and local checks alone do not establish a verified live cloud journey.

Existing Railway apps, integrations and operations follow the same safety
boundaries. Focused rules cover [lifecycle](docs/development/lifecycle.md),
[connections](docs/development/connections.md), [CI](docs/development/ci.md) and
[recovery](docs/development/recovery.md); they do not prescribe a second cloud
infrastructure engine.

## Product Model

The [common cloud user journey](docs/development/user-journey.md) defines the
GCP/AWS/Azure milestone, build order and observable acceptance. This architecture
defines its technical and safety boundaries. Backend implementation notes and
historical evidence do not add requirements to that milestone or prove it complete.

A user describes the app they want to run. Hypervibe inspects the repository,
chooses sensible infrastructure, connects the authorized account, explains the
proposal and cost implications, then delivers a verified running app. Deployment,
rollback, recovery, observability, secrets and third-party integrations belong in
that same experience. Ask for access and meaningful decisions, not a DevOps setup
checklist. Follow the [product rules](docs/development/product.md).

The central loop remains:

1. `hv_spec` records the intended app and infrastructure.
2. `hv_plan` observes current state, resolves dependencies and produces an exact
   proposal, including changes, costs, risks and blockers.
3. `hv_apply` executes only the approved, current plan and records partial outcomes.
4. Verification proves the intended infrastructure and application behavior.

A fresh repository can be inspected without writes. Only explicit desired-state
submission initializes managed project state. Unknown project selectors, missing
provider choices or ambiguous account scope must not silently choose a destination.
Read-only inspection is distinct from explicit, mapping-based adoption.

## Provider Scope

New cloud development targets GCP, AWS and Azure. Prove one complete cloud journey
before extending it; neither a registry entry nor a mocked test makes a provider
supported. Record implemented capabilities, verified paths and remaining gaps.

Preserve Railway for existing applications, including established state, bindings,
data and working workflows. A change to the cloud engine does not authorize moving
an existing application or discarding its data.

Retain useful authentication, cloud bootstrap, image build, registry, log,
deployment inspection and data-operation clients. Replace custom cloud resource
create/read/update/delete reconciliation with the OpenTofu integration. Do not
recreate the full cloud provider schema or lifecycle inside Hypervibe.

## Provider Boundary

Hypervibe owns application intent, user choices, authorization, dependency policy,
secret custody, workflow coordination and evidence. OpenTofu and its pinned provider
plugins own the new cloud infrastructure graph, resource diff, execution and state.
Provider-specific modules translate supported intent into engine configuration and
expose narrow operational capabilities where the engine is not the right owner.

| Responsibility | Owner |
| --- | --- |
| Desired app, environment policy, exact approval and result reporting | Hypervibe application layer |
| New cloud resource lifecycle and native resource state | OpenTofu with pinned provider plugins |
| Records in an explicitly selected existing Cloudflare, Cloud DNS, Route 53 or Azure DNS zone | Shared saved OpenTofu DNS plan and encrypted state; Hypervibe owns scoped observation, consumer dependencies and exact adoption approval |
| DNS security policy and certificate readiness | Hypervibe observation and blockers; zone creation, DNSSEC/registrar changes and automatic CAA policy mutations are unavailable |
| Account discovery, sign-in and credential refresh | Hypervibe connection capabilities |
| GCP project setup, billing attachment, APIs, identities, IAM and build resources | Project-shared OpenTofu state with exact setup approval |
| Source build, immutable release, rollout, logs and app checks | Hypervibe deployment and operations capabilities |
| SQL tasks, backup/restore execution and third-party APIs | Explicit Hypervibe operational/integration capabilities |
| Existing Railway lifecycle | Retained Railway capability until explicitly replaced |

GCP bootstrap discovers access through read-only APIs and delegates infrastructure
prerequisites to saved OpenTofu plans. Billing selection and infrastructure/access
approvals are distinct. Builds and operational helpers may not create missing
repositories, buckets, job runners or permissions. Missing prerequisites block
until the reviewed engine workflow creates them.
Engine and API operations share exact scope, redaction, approvals and result stages.
Generic orchestration routes by capability, not provider-name branches. New plugins
must declare supported work and fail explicitly for unsupported work.

DNS selection is independent of hosting. The four existing-zone DNS backends
have ordinary CI configuration checks with their actual pinned providers; their
installed live lifecycle remains unverified. See the
[DNS evidence record](docs/development/provider-evidence.md#existing-zone-dns-evidence)
for the precise coverage. Historical direct DNS adapter methods are not invoked
by managed domain, Pages or email record workflows; writes use saved engine plans.

## Engine Runtime And Installation

Hypervibe must provision a pinned, private OpenTofu runtime automatically for the
supported OS and architecture. Verify the downloaded artifact against its trusted
release metadata and checksum before execution. Install atomically into a private
cache, use the verified absolute path and fail safely on unavailable or invalid
artifacts. Do not execute an arbitrary engine found on `PATH` as a fallback.

Pin provider versions and dependency lock data with the generated configuration.
Use controlled plugin resolution and verify integrity before executing plugins;
unreviewed executable downloads are not an implementation detail to hide in apply.
Engine upgrades are reviewed product changes with compatibility evidence, not
implicit latest-version resolution during a deployment.

Users should not separately install OpenTofu, Terraform, cloud CLIs or Docker to
deploy an app. Remote image builds and supported SDK/browser authentication belong
inside the managed journey. The current npm installation still requires Node.js
and npm; a packaged path removing those requirements remains to be proven.
Never restart or kill a user's MCP/client process to activate a build or update.

## State Ownership

Keep desired intent, execution state, credentials and evidence distinct:

- The repository spec records reviewed application and infrastructure intent.
- Generated engine configuration is derived from that spec and pinned component
  versions. The exact configuration used for a plan is frozen with that plan.
- OpenTofu state records the engine's cloud resource identities and dependencies.
  It may contain secrets; never commit it or expose raw state through MCP/CLI.
- Non-secret bindings connect logical app resources to exact engine/provider
  identities and scope. They are references, not a competing lifecycle state store.
- Hypervibe local storage retains encrypted credentials and sensitive operation
  data, plus revisions, receipts and recovery metadata as appropriate.
- Live provider and application observations establish current reality. Cached
  state, an engine exit code or a prior receipt alone does not prove health.

Missing, unreadable, corrupt or incompatible state is not an empty deployment.
Block rather than replacing it with empty objects or creating replacement resources.
Keep state storage, encryption and locking explicit; do not introduce a remote
backend or credential-sharing service without defining ownership and authorization.

## Platform Bindings

Preserve native identity together with account/project, region and any required
resource scope. A name is a search hint, never proof of ownership or authority.
Map engine outputs to exact declared consumers through a bounded, validated binding
contract. Do not accept arbitrary output keys as app environment variables.

Repository exports contain only safe topology and identity metadata. Credentials,
connection strings, secret hashes and sensitive engine outputs stay inside the
protected boundary. Existing Railway bindings remain readable and authoritative
for their established resources; they do not dictate the new cloud state model.

## Plan Honesty

Persist the exact saved engine plan and the Hypervibe actions it participates in.
Bind approval to the project/environment, account scope, spec/configuration revision,
engine and provider versions, relevant state revision and exact external actions.
The human summary must cover the complete mutation set, including replacement,
deletion and costs; a friendly summary cannot authorize hidden engine actions.

Apply the reviewed artifact, never silently generate and execute a new plan after
approval. Reject stale inputs, conflicting state or a different dependency set.
Do not downgrade an unsupported plan shape to an apparently safe summary.
A noop plan has no writes, including bootstrap, repair and secret synchronization.

Show `succeeded`, `failed`, `skipped`, `pending` and `blocked` honestly. Distinguish
missing access from unmet prerequisites. A successful sign-in, accepted request,
workflow dispatch or engine run is not a verified deployment.

## Reconciliation Safety Invariants

- Every mutation belongs to an exact reviewed action and its declared dependencies.
  Helpers may not ensure unrelated resources from the wider spec.
- Billable and data-bearing actions require exact action confirmation. Account,
  billing, invitations, secret import and apply approvals stay distinct; reuse
  unchanged authorization within its scope.
- Observation is present, absent or unknown. Only provider-confirmed absence proves
  absence. Permission errors, partial reads, malformed responses, timeouts and
  ambiguous identities remain unknown and block dependent mutation.
- Verify prerequisite convergence before dependent effects. Do not remove bindings
  until deletion is confirmed; teardown follows dependencies and stops on failure
  or uncertainty. An attempted request does not establish cleanup ownership.
- Persist uncertain writes and operation identities before retry. Re-observe exact
  targets; do not replay, recreate or compensate from a guess.
- Lock the affected environment and engine state for mutations. Coordinate deploy,
  rollback, secret rotation and data operations with the same ownership boundary;
  overlapping operations must not invalidate each other's reviewed inputs.
- Failed, pending, blocked or confirmation-required stages stop dependent work
  unless an explicit bounded continuation applies. Read-only diagnosis does not
  authorize alternate provider writes or manual state/credential edits.

### Resource naming boundary

Keep logical names simple and provider identifiers valid. Generated uniqueness
must remain stable after binding. Never rename or adopt a durably bound resource
merely because a newly chosen default differs.

## Connections And Secrets

Discover required access early. Prefer verified scoped connections, supported
browser sign-in and safe credential references. Cloud login, billing attachment,
secret import and runtime credential delivery are different authorities.
Control-plane access does not authorize copying administrator credentials into an
app. Prefer supported workload identities with the least required permissions.

Secret values must not reach specs, repository bindings, public plans, logs,
receipts, error messages or interface output. Treat engine configuration, saved
plans, state, process environment and diagnostics as potentially sensitive.
Encrypt sensitive artifacts at rest, restrict filesystem access and process
inheritance, and redact before an interface or diagnostic sees content.

Keep source credentials separate from deployed app secrets. Scope every consumer
to its project, environment, service and purpose. Missing credentials are not
permission to widen access or silently create a new identity. See the
[connection rules](docs/development/connections.md).

## Runtime Secrets

Generate app-owned secrets within the encrypted lifecycle; request values only
when an external party owns them. Freeze approved replacements, preserve accepted
values across retries and verify delivery to the exact declared consumers.
Rotation with session, encryption or data consequences requires its own approval.
Write acknowledgement, value acceptance, activation and app health are distinct.

Do not expose secret-bearing engine output as a convenience API. Derive only the
needed runtime bindings privately and preserve provenance without secret values
or low-entropy hashes. See the
[runtime-secret rules](docs/development/connections.md#managed-runtime-secrets).

## Recovery Of Hypervibe State

Recovery must restore the managed system's identity, not infer a new deployment
from resource names. Define a versioned, encrypted recovery package containing
required Hypervibe metadata, engine state, pinned dependency information and
operation records. Keep the decryption key recoverable through an explicit,
separate custody path; never commit it or put it beside an unprotected export.

Retain the existing local encryption key when updating or restoring local state.
A missing key must produce a recovery blocker, not silent key regeneration over
existing ciphertext. Verify package integrity, schema and exact destination before
restoring; do not overwrite newer state or active locks. A recovery design is
unproven until a fresh installation can recover the same bindings and observe the
same resources without creating replacements. Infrastructure state recovery does
not itself restore application data.

## Project Runtime Desired State

Record runtime versions, build inputs, app commands and necessary environment
configuration in reviewed desired state. Infer sensible defaults from the repo;
preserve explicit user choices. Build reproducibly without requiring local Docker
or cloud tools. Do not promote a runtime or build change without fresh evidence.

A repository Dockerfile remains authoritative; do not replace it with a generated
build to bypass unsupported requirements. Generated builds must reject missing
or conflicting runtime and build commands. Scheduled jobs use their declared
command, never a substituted web or worker command. Isolated Hypervibe helpers
must not inherit application runtime settings.

## CI And Push Deploys

Keep one explicit deployment authority for an app environment. Provider-native
sources and managed CI must not race. Changing that authority is a planned change;
unknown source state cannot be treated as disconnected.

Build an immutable release from an exact repository revision. Record image digest,
build provenance, target environment, configuration contract and resulting native
deployment identity. Promote the verified artifact rather than rebuilding a mutable
branch. Required checks must cover the actual revision being deployed. Serialize
promotion and rollback with other environment mutations and reject stale evidence.

A dispatch is pending until observed completion and app checks prove the outcome.
Preserve repository-owned checks and user-selected review policy; another person's
merge approval is opt-in. See the [CI rules](docs/development/ci.md).

## Rollback And Observability

Rollback selects a known immutable release, verifies its provenance and current
compatibility, freezes the exact action, and checks the restored app afterward.
Do not redeploy the current checkout and call it restoration. Rollback does not
reverse database migrations or restore data; expose those limits before execution.

Give users scoped health, logs, deployment status and useful next actions. Keep
infrastructure convergence, deployment completion and endpoint health separate.
A healthy staging endpoint does not prove production or an integration is healthy.
Partial or unavailable evidence stays visible rather than becoming a green status.

## Database Provisioning And Persistence

Cloud database resources belong to the engine lifecycle. Keep SQL authentication,
connectivity, migrations and data operations in explicit operational capabilities.
Treat persistence, backup coverage and teardown dependencies as data-bearing
boundaries. Do not open public database access to bypass missing private access.
Preserve exact-identity cleanup of previously recorded access.

## Database Resilience

Report recovery protection separately from deployment health. Optional backup
setup or a new archive destination must not block ordinary deployment. Preserve
existing native protection; changing retention, replacing a datastore or creating
billable recovery resources requires a concrete approved action.

A successful backup request is not a recoverable backup. Verify artifact integrity,
source identity and usable restore evidence. Restore into isolated destinations
when supported, verify the restored data and app, and require explicit approval
before repointing consumers or overwriting live data. Unknown restore or cleanup
results stop dependent actions. See [recovery rules](docs/development/recovery.md).

## Database Tasks And Seed Data

Execute reviewed tasks against the exact environment and immutable application
release. Preserve acknowledged operation identities, bounded retries and scoped
secret delivery. Lock against conflicting deployment/data work. A seed command
must not silently become a recurring deploy hook or a production data reset.

## Third-Party Integrations

Retain integrations such as GitHub, DNS, Stripe and email behind explicit
capabilities. Integrations that only need an external API key or callback should
use declared secrets and webhooks rather than a new generic cloud lifecycle.
Keep management credentials separate from runtime keys; prove the exact account,
endpoint and required permissions before mutation. Engine adoption is not a reason
to rewrite useful integration clients.

See the [integration rules](docs/development/lifecycle.md#integration-action-ownership)
and [mobile release contract](docs/api-mobile-releases.md). Optional integrations
do not become onboarding prerequisites merely because they are available.

## Interface Boundary

MCP and CLI are thin adapters over `src/application`. Define command metadata,
validation, handling, redaction and results once; expose the same structured result
and safety contract through both. Interface code may parse, prompt and render,
but it must not call cloud APIs or invoke the engine independently.

Resolve repository and environment context per request. Ambiguous roots or a
mismatched repository identity fail closed. The agent installer remains a CLI-only
bootstrap exception: it installs the skill and matching MCP registration before
opening infrastructure state. It does not authenticate clouds, approve tools or
start/restart the user's client. See [installation](docs/agent-installation.md).

## Code Map

- `src/application/`: shared commands, context, results and application entrypoints.
- `src/interfaces/mcp/` and `src/interfaces/cli/`: transport adapters.
- `src/domain/spec/`, `src/domain/plan/` and `src/domain/services/`: intent, policy
  and orchestration; refactor cloud execution around the engine boundary.
- `src/adapters/providers/`: retained connection, operational and integration
  clients plus existing Railway behavior; avoid a parallel cloud CRUD framework.
- `src/adapters/db/repositories/`: protected local persistence and validated reads.

The code layout alone does not prove a complete cloud journey. Verify the managed
engine through the installed interfaces and the intended running application.

## New Provider Checklist

Prove one integrated path first: clean installation, authorized connection,
real generated configuration, pinned engine execution, an exact reviewed plan,
apply and a working app. Include the meaningful update, failure and recovery cases
for that path before expanding the supported surface.

Validate generated engine configuration with the real pinned binary/provider
versions. Keep boundary regressions in required CI: noop freedom, action scope,
stale plans, unknown reads, secret redaction, concurrency and confirmed teardown.
Use official provider evidence for retained API clients. Do not require bespoke
cloud CRUD/schema implementations or live support on every provider before one
usable path can ship. See [provider evidence](docs/development/provider-evidence.md).

## Tool And CLI Policy

Use supported Hypervibe commands for managed infrastructure. MCP agents call
available `hv_*` tools; the CLI reaches the same application and state. Neither
interface may bypass a blocked plan using direct provider writes, ad hoc scripts,
credential edits or resource recreation. Read-only diagnostics remain available.

Internally managed OpenTofu and its pinned plugins are allowed engine dependencies.
A separately user-installed provider CLI is not a deployment prerequisite. The
explicitly authorized Railway private SSH diagnostic exception remains narrow;
it does not authorize infrastructure changes or an automatic fallback.
