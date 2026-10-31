# Reviewed initial GCP billing assignment

This versioned setup mode assigns the selected billing account to the exact project
created by the preceding installation operation. It is an authoritative initial
assignment, not a conditional link-only API. The administrator reviews the native
project ID/number/createTime/observed parent, selected open billing account and cost
implications before confirming the billable action. During this setup the project
must be reserved for the reviewed installation; external administrators must coordinate
billing changes. Google can replace a concurrent association after our final read.

The [billing PUT contract](https://docs.cloud.google.com/billing/docs/reference/rest/v1/projects/updateBillingInfo)
and [ProjectBillingInfo schema](https://docs.cloud.google.com/billing/docs/reference/rest/v1/ProjectBillingInfo)
provide no etag, request ID or conditional-empty field. [Switching permissions](https://docs.cloud.google.com/billing/docs/how-to/modify-project)
allow unlink through either project permission or the previous account's permission.
A selected-account permission probe cannot prove the absence of the latter elsewhere.
[PAB enforcement](https://docs.cloud.google.com/iam/docs/pab-blocked-permissions) covers
Cloud Billing budgets, not resource associations; [credential access boundaries](https://docs.cloud.google.com/iam/docs/downscoping-short-lived-credentials)
only support Cloud Storage. Neither makes this operation atomic.

New discovery uses `assignmentMode: initial-reviewed-v1`, carried through the project
and billing scope journals. Existing unversioned blocked billing records remain
blocked. A new review, never a flag change to an old plan, authorizes this mode.

The transient browser token performs one exact PUT. No temporary service account,
custom role, billing IAM grant or host impersonation is created by this mode. The
required authority is project get/createBillingAssignment and Service Usage reads,
plus selected-account get/resourceAssociations.create. Older temporary-principal
records retain their exact read-only recovery and separately reviewed cleanup.

A different association observed before dispatch is preserved and blocks the action.
The original project lifetime, creation attempt/ownership and parent are checked,
and the shared journal records the attempt before dispatch. Missing/uncertain responses
never cause a replay. Read-only recovery can verify the selected association; conflicting
or unreadable state stays blocked. No billing detach or restoration is automatic.
The resulting scope-ready receipt authorizes only a fresh collection/deployment review.

Offline serialized-transport tests cover the review, exact confirmation, one PUT,
permission failure, pre-existing account preservation, explicit concurrent-change
semantics, lost acknowledgement and old-record compatibility. Native billing authority,
reauthentication and charge behavior require the approved disposable-account walkthrough.
These tests establish the implementation boundary, not successful live first release.

The challenged assumption was that a newly created link-only principal could prove
it lacked unlink authority on every other billing account. The official switching
contract permits inherited unlink authority; tests retain that counterexample for
old plans. Four new-mode regressions failed before the versioned assignment existed.
A separate real transport regression observed a PUT after app authority was revoked
during the final billing read; authorization now runs after that read and before
dispatch. Independent review then reproduced two failures where a known project's
Billing GET returned 404: planning treated it as an empty association and the final
read still allowed PUT. The [GET contract](https://docs.cloud.google.com/billing/docs/reference/rest/v1/projects/getBillingInfo)
returns ProjectBillingInfo on success; an unassociated project retains its identity
with empty/default account fields. All billing reads now preserve 404 as unknown,
while valid omitted/null protobuf defaults remain accepted. The four-file billing,
project and shared lifecycle group passes 64 tests after these observed failures.
These tests run under ordinary `npm test` discovery.
