# Completed operator setup retirement — contract and staged implementation

Shared declaration/journal foundation based on `2f029c9f9683a88320d05b16c27eb28d3d6edcc2`.
Production provider retirement drivers and plan projection are not implemented.
No provider writes, new browser sessions or remote changes were made.

## Outcome and boundary

“Remove this test setup” should produce one understandable review: the exact app,
environment and accounts, what stops working, what is deleted, what is retained,
and any charges or provider recovery windows that remain. The agent performs
supported API work and can operate a reviewed browser handoff where the provider
has no documented API for the exact resource type. Routine subactions use the
same approved review; changed targets or data disposition require a new review.

The failure assumption is that removing a desired declaration, disconnecting
collection access, or completing an installation's failure compensation also
retires a successfully created operator resource. The source contradicts this:
operator application/artifact intents only connect, their projected plans only
prepare/recover/verify, and omitted completed declarations emit no delete.
SendGrid's exact-key deletion is compensation for an incomplete key transaction,
not a normal completed-key retirement path. These are confirmed source gaps;
the boundary checks below implement only the shared foundation, not provider teardown.

The five external registrations below are **one-time Hypercloud operator-hosting
setup**, not prerequisites that every new customer must create. AWS/Azure/GCP
customer disconnect remains separately authorized removal of hosted trust. It
intentionally preserves secret values and independently authorized runtime readers.
Deleting a customer's resources or data needs an explicit retirement review.

## Extend the existing lifecycle

1. Extend `operatorApplications.<name>` and `operatorArtifacts.<name>` with an
   optional strict `retirement` declaration. Omission remains non-destructive;
   it is never interpreted as permission to delete. The accepted declaration shape is:

   ```json
   {
     "retirement": {
       "from": {"installationId": "<accepted-id>", "planDigest": "<accepted-digest>"},
       "resources": "delete-owned",
       "data": "retain"
     }
   }
   ```

   Both dispositions must be explicit. `data` may be `retain` or `delete-owned`;
   the provider declares which combinations it can implement. No arbitrary
   purge/force option or name-prefix sweep. The referenced record selects its
   exact native resources; old published versions from other accepted records
   require their own exact `targets: [{installationId, planDigest}]` selections, which may share one human review. Each selected record must be an accepted ancestor in the same local journal; the intent freezes its validated completion-evidence digest. There is no implicit sweep of history.
   When data is retained, the reviewed plan must list every container that must remain to hold it. `resources: delete-owned` does not override that data choice or promise deletion of those containers; `retired` means the explicitly declared outcome was verified.
   Output secret containers/versions and ordinary backup storage are separate
   existing desired-state resources, not implicit children deleted by registration.

2. Add an optional retirement capability to the existing application/artifact
   capabilities. It parses the request, validates historical creation/publication
   evidence, derives immutable native targets and supplies the existing
   `plan/inspect/mutate/recover/parseEvidence` driver. Generic code sequences
   explicit dependencies and authorization; providers own APIs, native identity,
   absence semantics, retention and browser destinations. No second delete engine.

3. Use a new **local-only** operator intent `mode: retire`, with a new installation
   ID and predecessor `{installationId, planDigest}`. Preserve the original
   accepted record, attempts and output custody. The intent additionally freezes
   the selected creation-evidence digest, native target set and dispositions.
   Do not overload hosted `disconnect`, whose destructive actions are deliberately
   restricted to trust removal. Do not reuse connect/restart/refresh intent IDs.

4. Reuse the existing installation kernel's immutable plans, exact action IDs,
   before-mutation authority checks, write-ahead attempts and SQLite CAS. Add a
   local-only `retired` terminal state, accepted only for these retirement intents;
   ordinary hosted v1 intents/status projections remain unchanged. This avoids
   interpreting an absent registration as `scope-ready` setup. Existing readers
   must distinguish provisioning history from retirement history. Older local
   clients must fail closed on an unknown retirement record, never recreate it.

5. Project actions through the current operator application/artifact plan stages,
   adding a retirement mode to their exact metadata validators. Expose selection
   through the existing `hv_spec → hv_plan → hv_apply` commands, consistently in
   CLI/MCP metadata. A retirement plan must not run registration, image builds,
   upload, deployment, unrelated provider authentication or secret delivery.
   Setup readiness is not a prerequisite: use the accepted resource identities
   even when its old website has stopped or the old connect observation is stale.
   Fresh cleanup authority and current exact native identity remain required.

## Evidence, dependencies and recovery

- Admit a completed registration/publication from validated historical evidence,
  not just a mutable `scope-ready` status. Unknown/rejected/partial predecessor
  effects first use their existing read-only recovery. Do not turn an unfinished
  browser registration into absence, a fresh registration, or deletion by name.
- Bind cloud account/tenant/project number/region, exact resource IDs and native
  lifetime identifiers. Use etag/generation/version preconditions where the
  documented delete API supports them; do not invent a conditional header where
  it does not. For endpoints without atomic conditions, record the residual race
  and prefer unrepeatable native IDs, not reusable names.
- Include dependent consumers in the review and check them again before deletion.
  Finish hosted trust cleanup while its source and host authority remain usable;
  stop new requests and automatic deploy/backup producers; remove live consumers;
  then retire their dedicated keys/apps/images. Keep the local cleanup credential
  until the work it authorizes is verified. Public template/image consumers outside
  the reviewed test scope block deletion; “we created it” does not prove unused.
- Every DELETE, grant removal, browser handoff and local active-binding removal is
  attributed to an exact current action/dependency. `noop` stays mutation-free.
  Removing native access never authorizes deleting values or unrelated permissions.
- Persist each attempt before dispatch. Recover acknowledged/pending/uncertain
  outcomes by exact operation/target readback, without automatic DELETE replay.
  A definite rejection may use the existing explicit retry confirmation. Missing
  historical operation records do not invalidate already verified terminal effects.
  Fresh authoritative absence may finish an idempotent delete, while 403, ambiguous
  404, partial inventory, timeouts and wrong-lifetime replacements stay unknown.
- Browser-only actions reuse the local branded review/handoff, current owner
  authorization, nonce/CSRF checks and exact allowlisted provider destination.
  The agent may operate that handoff within the approved scope. Do not log browser
  tokens or treat an owner's “done” response as automatic native proof; retain the
  exact authenticated owner-view observation and its verification limits.
- Retain a strict nonsecret receipt per target: original identity, requested
  disposition, active result, operation receipt, verification time and provider
  retention facts. Active absence and permanent erasure are different facts.
  `removed`, `deletion-scheduled` and `retained-by-choice` are distinct outcomes;
  pending/unknown/browser-unverified work cannot become `retired`. An unfinished delete/LRO remains pending. `deletion-scheduled` is allowed only after the native operation has completed the requested active removal and provider retention is independently established; it does not wait out that known recovery window. Keep exact
  version/generation and any required restore token plus retention dates in local
  protected operational state, without placing arbitrary provider payloads or
  secret material in output. Read-only rechecks update retention observations.
- Clear only the matching active binding using CAS after its requested outcome is
  proven. Keep retirement/retention history even when its active binding is removed.
  A retired leaf cannot satisfy `assertOperatorApplicationsComplete`, image receipt
  selection, source setup, runtime secret readiness or new deployment prerequisites.
  Reusing the logical name requires an explicit new registration, never resurrection.

## Named provider decisions

| Resource / provider | Supported native operation to implement | Completion and explicit limits |
| --- | --- | --- |
| Google browser OAuth client | Reviewed Google Auth Platform **Clients** browser handoff for the exact project/client; no undocumented API | Owner-authenticated browser evidence is distinct from API proof. A failed token request is not deletion proof. Google documents restoration for 30 days. IAM `projects.locations.oauthClients` is a Workforce/IAP feature and cannot substitute for this web client. |
| GitHub App registration | Reviewed owner-settings browser handoff; independently inventory exact App ID/owner and installations first | Deleting the registration uninstalls it everywhere. The API's `DELETE /app/installations/{id}` removes one installation, not the registration. Unexpected installations block whole-App deletion. A public lookup 404 or rejected JWT is not sufficient proof. |
| Microsoft Entra app/FIC | Graph exact application object-ID / federated-credential-ID deletion | Remove the dedicated FIC before the application if both selected. App deletion is soft deletion for 30 days; permanent deleted-item purge is a separate data-loss action. Preserve shared tenant, unrelated apps and credentials; inspect separately created service principals rather than assuming they are deleted. |
| Google reCAPTCHA key | `DELETE /v1/projects/{project}/keys/{key}` | Empty request body; validate exact project/key ownership, observe absence. Preserve the older production key and API consumers. No invented etag condition. |
| SendGrid runtime key | `DELETE /v3/api_keys/{api_key_id}` with the existing management connection | Exact account/subuser/key ID; 204 acknowledgment and scoped metadata readback. Brief revocation propagation is documented. Never delete the shared account, verified sender/domain or management key. No test mail is required. |
| AWS publications | Existing `s3` artifact capability, extended for exact CloudFormation/S3 identities and version IDs | Follow the separate artifact matrix. Stack `DELETE_COMPLETE` does not delete a `Retain` bucket. Public policy, object versions/delete markers and bucket/container effects remain individually reviewed. No AWS-account closure. |
| GCP publications | Existing `cloudrun` publication journal for exact image digests; repository/grant retirement belongs to its original local-scope creation journal | Follow the artifact matrix. LRO completion and exact native absence are required; active image/backup/template consumers block retirement. A publication that references a repository cannot establish repository creation ownership. |
| Azure publications | No registered operator-artifact publication capability today | Declare unsupported for this facet; do not invent ACR publication support to claim three-provider parity. Existing ACA/ACR or storage lifecycle uses its own exact bindings. |
| GCS backups | Existing storage teardown and exact task-produced generation receipts | Not an operator artifact registration. Versioned and soft-deleted objects need independent retained outcomes even when ordinary GET returns 404 or bucket deletion succeeds. |

Provider APIs and limits above are design evidence, **not implemented or live-tested
retirement support**. The linked machine matrix records evidence for all named
providers; shared roster tests must fail when a new registered provider is omitted.

## Dedicated parent test scope

For this dedicated GCP test project, a supported parent shutdown may avoid needless
individual deletion and a separate OAuth browser step, but only through a separately
reviewed parent action. It requires the original project-number/creation evidence,
fresh project/parent/lifetime authority, complete bounded inventory of known children,
and an explicit owner decision to delete **all** contents of that exclusive test
project. Unknown or shared children block the narrow “delete only what we created”
mode. Broader whole-parent consent must be explicit, never inferred from labels.

Perform external GitHub/Entra/SendGrid cleanup and required hosted-trust cleanup first.
Do not destroy the authority/source needed to finish them. Preserve the shared billing
account. Google `projects.delete` marks `DELETE_REQUESTED`; retain the operation,
project number, request time and child retention evidence. Report shutdown requested
and the recovery window, not immediate permanent erasure or instant disappearance of
all charges/quota. Google documents a 30-day project window and potentially earlier
loss of individual resources. OAuth child outcome is “covered by parent shutdown,”
not a fabricated per-client deletion receipt.

For AWS the parent is the exact owned stack/resource set, never the account; retained
children remain inventoried. For Azure an exclusive reviewed resource group can be
the parent, never the tenant/subscription. ARM deletion may cover more resources than
the caller can delete individually, so inventory and scope consent cannot be replaced
by a permission check. Locks, vault retention/purge protection and out-of-group Entra
apps remain separately recorded. Do not remove locks or weaken retention implicitly.

## Delivery slices and acceptance

1. Agree this shared contract and the artifact/storage matrix; no provider writes.
2. Add strict local intent/declaration/action/receipt schemas and journal lifecycle,
   with real SQLite/command regressions before runtime changes.
3. Implement the known completed external identities (SendGrid, Entra, CAPTCHA),
   then exact browser handoffs. Add parent GCP retirement only after dependency and
   retained-data contract coverage; do not hide unsupported retirement behind it.
4. Implement AWS/GCP artifact and existing storage retirement from the peer matrix;
   keep Azure's absent publication facet explicit.
5. Run normal CI and an owner-approved disposable cleanup walkthrough. Report each
   native outcome and retained item; do not call full test teardown complete while
   a dedicated external app, unverified earlier registration, live grant, stored
   secret, artifact, backup or hosted-data cleanup obligation remains unaccounted for.

Hosted bulk test-data purge, exact fixture-branch retirement and local private-artifact
cleanup remain separate gaps from this operator lifecycle. Preserve their records
until trust cleanup no longer needs them; deleting the database/project is not proof
that external trust or applications have been removed.

See `operator-retirement-regression-plan.json` and
`../test/provider-contracts/operator-retirement-provider-matrix.json` for the
implementation acceptance cases and official source links.

## Shared foundation evidence and remaining implementation

The first slice accepts strict application/artifact retirement declarations and
local-only operator intents, with exact predecessor and historical evidence
selection. It rejects retirement through ordinary hosted authority, refuses
creation/replacement actions, persists a distinct terminal `retired` record, and
retains each nonsecret native retention outcome. A retired leaf cannot resolve a
ready setup scope or provide provisioning/image completion evidence; neither a
journal write nor a new child can silently reopen it. Old non-retirement drivers
reject these records instead of reconstructing an absent resource.

The command surface deliberately stops full planning with an unsupported result
before cloud preparation, origin setup, output containers or image builds. No
production driver advertises the new capability yet. This is an explicit remaining
implementation gap, not a successful deletion path. Narrow independent recovery
scopes retain their existing authority and are not converted into retirement.

Observed RED before the runtime changes: three schema/kernel checks failed; three
actual CLI/MCP/command checks reached the wrong setup interpretation; three
terminal/retention checks accepted reopening or incomplete native identity; two
terminal checks accepted unresolved status; one disposition check accepted retained data after a delete-data request, and one permissive-policy check reached a connect planner with a retired parent. Their passing counterparts exercise
real SQLite restart, exact predecessor preservation, one lost-ack dispatch,
retention outcomes and safe unsupported planning. Provider responses in these
shared tests are labeled synthetic policy fixtures, not native API evidence.

Both new test files are included by `vitest.config.ts`'s ordinary `src/**/*.test.ts`.
The committed `hypervibe-acceptance.yml` and desired `.hypervibe/spec.json`
`Hypervibe / acceptance` check run `npm test` and `npm run typecheck`. This verifies
repository CI reachability, not live branch-protection enforcement. Actual
provider cleanup, browser-only deletion proof, data/container disposition plans,
output-secret retirement, dependency ordering and a disposable live walkthrough
remain required before any full-cleanup claim.

Verification for this shared slice: the eight focused existing/new suites passed,
then the final two new suites and both affected application/artifact plan/apply
suites passed after the last admission guard. TypeScript and diff checks passed.
These are local executed checks; the new commit has not yet run in remote CI.
