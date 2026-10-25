# Hosted cloud scope preparation

Scope preparation is a separately reviewed installation stage, before collection
installation. It uses transient browser authorization and the same durable CAS
records, exact action confirmations, dependency ordering and read-only recovery.
It never loads ADC, opens local SQLite, creates a private key or authorizes a
deployment. Existing collection records omit `stage` and retain their digest.

| Provider | Native scope mechanism | Current preparation capability |
| --- | --- | --- |
| AWS | Customer selects an existing account in the reviewed CloudFormation console installation. Creating an organization member account has different authority and lifecycle. | Unsupported; no account-creation stage is inferred from CloudFormation support. |
| Azure | Customer selects an existing tenant/subscription. Subscription creation and billing ownership are separate Azure APIs and agreements. | Unsupported; existing reviewed resource installation remains separately blocked where atomic create ownership is unverified. |
| GCP | Resource Manager POST creates a project and returns an operation; a second reviewed scope operation handles billing. | Project creation/recovery, existing-billing verification and historical temporary-grant cleanup have offline acceptance. Automatic attachment is blocked before temporary writes. No live walkthrough completed. |

The ordinary provider-roster test requires all three providers to declare this
boundary. [AWS account creation](https://docs.aws.amazon.com/organizations/latest/APIReference/API_CreateAccount.html),
[Azure subscription creation](https://learn.microsoft.com/en-us/azure/cost-management-billing/manage/programmatically-create-subscription),
[Google project contract](https://github.com/googleapis/googleapis/blob/master/google/cloud/resourcemanager/v3/projects.proto)
and [Google billing contract](https://github.com/googleapis/googleapis/blob/master/google/cloud/billing/v1/cloud_billing.proto)
are independent sources; this matrix does not claim live compatibility.

## GCP project and billing behavior

Browser discovery offers a proposed project with a deterministic native ID and
an open billing account visible to the administrator. Discovery is not permission
proof. Planning verifies the selected account, its link permission and explicit
parent create permission where a parent is selected. Unknown project lookup
does not prove absence. A foreign existing ID blocks; it is never adopted.

An omitted parent is explicitly reviewed as Google-selected, not as proof of
“No organization.” Google may select an organization from the user's domain.
The actual returned parent is retained with the immutable project number and
creation time. Project ownership and attempt labels are set in the create POST.
The administrator, not Hypercloud's host service account, creates the project.
See [Google project creation](https://docs.cloud.google.com/resource-manager/docs/creating-managing-projects).

The write attempt is durable before the POST. A returned operation identity is
retained, observed without another write and correlated with a fresh project
read. Google expires these operations after hours, so recovery also checks the
exact project ID, ownership labels, attempt and retained lifetime. A missing or
unknown response never permits blind resubmission. Definite rejection requires
a separate exact retry confirmation. Created projects remain on partial failure;
this stage has no deletion or compensation authority.

Project-only completion returns `scope-ready`, which is not billing readiness.
`cloudInstallationNextStageV1` selects another `scope-preparation` review. That
review shows the observed actual parent, selected billing account and candidate
temporary identity permissions. Each scope operation has its own UUID, plan
digest and durable history; the original plan is never rewritten. After billing
is independently verified, the same continuation route selects `collection`.
Neither scope-ready result can project writer connections or accept values.

If the selected billing account is already associated and enabled, the billing
stage contains one verification noop. It changes no billing or IAM resources.
A different account blocks and is preserved. If no association exists, the plan
has the immutable blocker `billing_assignment_unverified` before **any** temporary
API, identity or IAM write. Confirming every action cannot override it, and
direct provider mutation also rejects new setup/attachment. No owner-token PUT
fallback or configuration escape exists. A missing association therefore remains
an explicit fresh-customer onboarding gap; manual attachment does not satisfy
the requested automated experience.

The native candidate uses a dedicated service-account UID, an exact-project
custom link role (without `deleteBillingAssignment`), selected-account
`roles/billing.user`, narrow host impersonation and 15-minute tokens. Its review
shows the additional `billing.accounts.setIamPolicy` administrator prerequisite,
temporary grants, retained inert account/roles and potential usage charges.
These candidate writes are deliberately unreachable until preservation is
established. The counterexample is a principal with pre-existing inherited
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
evidence of a safe complete billing flow. Current tests exercise the production
blocker and existing-association noop; cleanup tests explicitly reconstruct
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

Billing automation, approved host/OAuth configuration, actual packaged consumer
acceptance and all three approved provider walkthroughs remain release gates.
Both PRs remain drafts; this change grants no merge, publish or deployment approval.
