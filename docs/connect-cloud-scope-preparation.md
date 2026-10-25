# Hosted cloud scope preparation

Scope preparation is a separately reviewed installation stage, before collection
installation. It uses transient browser authorization and the same durable CAS
records, exact action confirmations, dependency ordering and read-only recovery.
It never loads ADC, opens local SQLite, creates a private key or authorizes a
deployment. Existing collection records omit `stage` and retain their digest.

| Provider | Native scope mechanism | Current preparation capability |
| --- | --- | --- |
| AWS | Customer selects an existing account in the reviewed CloudFormation console installation. Creating an organization member account has different authority and lifecycle. | Unsupported; no account-creation stage is inferred from CloudFormation support. |
| Azure | Customer selects an existing tenant/subscription. Subscription creation and billing ownership are separate Azure APIs and agreements. | Subscription/billing preparation is unsupported. Within an existing scope, the reviewed exclusive app/environment namespace uses actual ARM deployment provenance and upsert semantics for collection and [prepared hosting](connect-cloud-azure-prepared.md); historical atomic-create-blocked plans retain their restrictions. Live walkthrough remains outstanding. |
| GCP | Resource Manager POST exclusively allocates a globally unique project ID and returns an operation; a second reviewed scope operation handles billing. | New `create-exclusive-v1` reviews authorize one allocation attempt even when the exact lookup returns403/unknown; they require terminal operation plus fresh lifetime proof. Old plans retain their rules. Versioned initial billing assignment, existing-billing verification and historical temporary-grant cleanup have offline acceptance. No live walkthrough completed. |

The ordinary provider-roster test requires all three providers to declare this
boundary. [AWS account creation](https://docs.aws.amazon.com/organizations/latest/APIReference/API_CreateAccount.html),
[Azure subscription creation](https://learn.microsoft.com/en-us/azure/cost-management-billing/manage/programmatically-create-subscription),
[Google project contract](https://github.com/googleapis/googleapis/blob/master/google/cloud/resourcemanager/v3/projects.proto)
and [Google billing contract](https://github.com/googleapis/googleapis/blob/master/google/cloud/billing/v1/cloud_billing.proto)
are independent sources; this matrix does not claim live compatibility.

## Local operator: empty-project allocation

Hypercloud cannot use its own hosted identity before that host exists. The local
operator path therefore has a separate, explicit administrator execution kind;
it never invents a future service-account identity or turns local login into a
collection or deployment credential. Its source is the exact local spec revision
and digest, not a fabricated Git commit. Existing hosted intents and their digests
retain their browser/host authentication contract.

The desired `hosting.scopePreparation` contains `schemaVersion: 1`,
`authentication: local-default`, and provider-owned `nativeScope`. CloudRun's
strict native scope is `scopeKind: project-allocation`,
`allocationMode: create-exclusive-v1`, exact `projectId`, `displayName`, and an
optional explicit `parent`. Billing fields, existing scope coordinates, secret
keys, hosted identities, deployment purpose and predecessor continuations are
not accepted. AWS account creation and Azure subscription creation remain
unsupported by this local capability; ordinary local authentication to their
existing accounts is a different capability.

The provider factory loads the real Google user ADC client, boundedly refreshes
its transient token, and scopes native requests to the reviewed project. A quota
project may supply the documented quota header; it never changes the resource
target. Service-account and impersonated ADC sources are not silently substituted.
Credentials, local credential-file contents and token responses are never part
of the plan, journal, receipts or command result.

The shared kernel admits exactly one project/scope/API action for this local
execution kind. Normal plan/apply authority binds that same action to the local
spec and durable operation, and the shared CAS attempt is written before the
exclusive POST. No billing read or write, API enablement, identity grant,
connection publication, database or workload belongs to this stage. A successful
terminal operation and fresh lifetime proof produce `scope-ready`: **an empty
project, not a configured host**. There is no automatic hosted continuation or
deletion authority. Billing and other setup require separate desired-state plans.

The local no-host counterexample failed three shared lifecycle tests before this
execution contract. Four native transport cases then failed because the old
project scope required billing; they passed with the project-only scope. The
real ADC loader/OAuth/CRM boundary is tested using a temporary synthetic user
credential file and reconstructed HTTP responses. An already-cancelled token
request initially still started OAuth refresh; a separate regression now checks
that cancellation prevents dispatch. These are offline contract checks, not a
completed live project allocation or a claim that the full hosting budget is
approved. The application integration additionally tests the ordinary persisted
plan/apply and SQLite journal path.

## GCP project and billing behavior

Browser discovery offers a proposed project with a deterministic native ID and
an open billing account visible to the administrator. Discovery is not permission
proof. Planning verifies the selected account, its link permission and explicit
parent create permission where a parent is selected. Unknown project lookup
does not prove absence. A known existing ID blocks; it is never adopted.

New discovery proposals carry the digest-bound
`allocationMode: create-exclusive-v1`. Under the explicitly approved allocation
policy, this review authorizes one exclusive native `CreateProject` attempt for
the exact ID. It does not infer a create from absent drift. A403 lookup remains
unknown and is shown as such;401,429,5xx and other failed observations still block.
Google's [creation guide](https://docs.cloud.google.com/resource-manager/docs/creating-managing-projects)
requires a globally unique ID that has never previously been used, including by
deleted projects. The [POST endpoint](https://docs.cloud.google.com/resource-manager/reference/rest/v3/projects/create)
does not update, undelete or adopt another project. Collision/rejection ends this
review's one attempt without renaming or retrying. Even a separately confirmed
retry cannot dispatch another create from that saved plan. A new allocation needs
a new review. Existing unversioned plans still require a confirmed not-found
lookup; no flag or confirmation can upgrade a saved plan or its digest.

An omitted parent is explicitly reviewed as Google-selected, not as proof of
“No organization.” Google may select an organization from the user's domain.
The actual returned parent is retained with the immutable project number and
creation time. Project ownership and attempt labels are set in the create POST.
The administrator, not Hypercloud's host service account, creates the project.
See [Google project creation](https://docs.cloud.google.com/resource-manager/docs/creating-managing-projects).

The write attempt is durable before the POST, and authorization is checked again
after native permission reads immediately before dispatch. A returned operation
identity is retained and read without another write. New allocation completion
requires a successful terminal operation whose protobuf Any response identifies
the v3 Project type, plus a fresh exact project read matching ID, number,
creation time, actual parent, owner and attempt. Only then is completed-operation
proof retained. Google expires operations after hours; an already-proven terminal
operation remains historical evidence, while its exact project lifetime is still
freshly checked. An expired operation that never reached proven completion, or a
lost acknowledgment without an operation ID, remains pending. Matching labels on
a same-name project cannot replace the missing operation proof. Unversioned
historical plans retain their older read-only recovery and rejected-retry rules.
Created projects remain on partial failure; this stage has no deletion or
compensation authority.

Project-only completion returns `scope-ready`, which is not billing readiness.
`cloudInstallationNextStageV1` selects another `scope-preparation` review. That
review shows the observed actual parent, selected billing account and exact
administrator permissions. Each scope operation has its own UUID, plan
digest and durable history; the original plan is never rewritten. After billing
is independently verified, the same continuation route selects `collection`.
Neither scope-ready result can project writer connections or accept values.

If the selected billing account is already associated and enabled, the billing
stage contains one verification noop. It changes no billing or IAM resources.
A different account blocks and is preserved. New discovery records
`assignmentMode: initial-reviewed-v1` in the original project intent and carries
it into billing continuation. Its separately confirmed billable action uses the
transient browser administrator to assign the selected account to the exact newly
created project. The review explicitly reserves the project during this operation:
Google's PUT has no conditional-empty guard and can replace an external association
made after the final read. This is an authoritative initial assignment, not a
link-only claim. It creates no temporary IAM identities or grants. See the
[assignment evidence and counterexamples](connect-cloud-gcp-billing-assignment.md).

Existing unversioned plans retain the immutable `billing_assignment_unverified`
blocker before any temporary writes. Confirmation cannot upgrade their authorization,
and there is no credential fallback or flag that changes an existing plan. An
uncertain new-mode PUT is recovered only through exact native observation; it is
never automatically repeated, detached or restored.

The older native candidate used a dedicated service-account UID, an exact-project
custom link role (without `deleteBillingAssignment`), selected-account
`roles/billing.user`, narrow host impersonation and 15-minute tokens. Its review
shows the additional `billing.accounts.setIamPolicy` administrator prerequisite,
temporary grants, retained inert account/roles and potential usage charges.
These candidate writes remain deliberately unreachable. The counterexample is a principal with pre-existing inherited
`billing.resourceAssociations.delete` on another account B, where another actor
associates B after the last read. Negative permission tests on target A do not
prevent a subsequent PUT from switching B to A. A delete-only custom grant need
not make B discoverable through get/list. This differs from a new administrator
grant made after verification. See [billing permissions](https://docs.cloud.google.com/billing/docs/how-to/modify-project),
[billing permission inheritance](https://docs.cloud.google.com/billing/docs/how-to/custom-roles)
and the [updateBillingInfo contract](https://docs.cloud.google.com/billing/docs/reference/rest/v1/projects/updateBillingInfo).

A project IAM deny fence for competing billing attachments is a possible future
design: the permission is on Google's [supported deny roster](https://docs.cloud.google.com/iam/docs/deny-permissions-support).
It is not implemented. Policy creation/LRO success and an owner permission probe
do not establish globally atomic enforcement: Google explicitly describes deny
changes as [eventually consistent](https://docs.cloud.google.com/iam/docs/access-change-propagation).
No fixed sleep or mocked permission denial is treated as a native guarantee.

Historical partial temporary-principal installations can be explicitly cleaned
up even when attachment failed. `cloudInstallationDisconnectionIntentV1` projects
only proven grants after read-only reconciliation; an uncertain unobserved grant
blocks that projection. The separate disconnect review removes exact project,
billing and host-impersonation memberships with etags, preserving unrelated IAM,
the project, account/roles and whichever billing account is attached. A project-only
stage returns explicit no-cleanup, not a fabricated disconnection receipt.
Lost removal responses recover through fresh reads without replay. Missing
administrator authority leaves cleanup incomplete; minted tokens and IAM
propagation retain their stated expiry limitations.

Every later-stage authorization re-observes exact predecessor evidence, including
actual parent and billing. The bounded lineage rejects cycles and cross-customer,
environment, source or host changes. Completed grants are discharged only by
correlated cleanup attempts plus fresh absence and identity proof, so historical
reconciliation cannot reinstall removed temporary access.

## Acceptance evidence

The new allocation counterexample came from a bounded operator read: an exact
proposed ID returned403 `IAM_PERMISSION_DENIED`, while browser-authenticated
project/billing discovery succeeded. This proves unknown lookup, not absence or
the cause of every onboarding failure. Six new shared-lifecycle/native-transport
tests failed before the explicit contract; the complete 21-case project suite then
passed. A further native counterexample initially accepted a terminal operation
with a missing protobuf Any type as scope-ready; the new mode now preserves
pending instead. [ProtoJSON Any representation](https://protobuf.dev/programming-guides/json/)
and the published v3 project schema supply the independent type/identity contract.
Independent review also reproduced explicit empty/null parent fields staying
pending while omitted parent succeeded. The provider now normalizes those
documented scalar defaults to observed no-parent; exact identity, ACTIVE state
and configured-parent matching still remain mandatory.
The normal provider-roster test rejects the allocation field on AWS, Azure,
ordinary GCP scopes and non-project operations. Tests also cover exact confirmation,
revocation during awaited permission reads, collisions, lost acknowledgments,
expired operations, no-org parent observation, unchanged old plans, separate
billing continuation and mutation-free re-observation. No allocation was attempted
against a live cloud by this change.

Assumption challenged: collection installation can require an existing project
number without leaving fresh-customer project creation to a dashboard chore.
Counterexample: an authorized browser administrator with a billing account and
no project cannot produce the required number. Four new real shared-engine /
native-transport cases initially failed with `invalid_contract`; after the
staged contract they passed. Tests use reconstructed REST responses from the
official contracts, not captured successful cloud calls.

The billing candidate's four initial native/shared tests failed before the staged
implementation, then passed against reconstructed transports. Adversarial review
added the account-B counterexample: it failed with one PUT before the immutable
blocker and passed with zero afterward. Those earlier candidate passes are not
evidence of a safe complete billing flow. Current tests exercise the old-mode
blocker, new explicitly reviewed initial assignment and existing-association noop;
cleanup tests explicitly reconstruct
historical attempts/native state without enabling a production bypass. Lost
cleanup acknowledgement initially failed recovery; durable attempt correlation
fixed it. Incomplete native completion evidence also failed before strict
action-specific proof validation and passed afterward.

The suite covers creation ownership, denied reads, insufficient authority,
foreign IDs, pending and expired operations, lost acknowledgments/restarts,
changed project lifetimes, existing billing preservation, read-only noop,
explicit rejected-write retries, scope discovery, separate writer review and
cross-environment predecessor rejection. `npm test` runs the suite and provider
roster normally. Actual Google permissions, organization policy, quotas,
parent selection and a disposable-account walkthrough remain unverified.

Live initial billing acceptance, approved host/OAuth configuration, actual packaged consumer
acceptance and all three approved provider walkthroughs remain release gates.
Both PRs remain drafts; this change grants no merge, publish or deployment approval.
