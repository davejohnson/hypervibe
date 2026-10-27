# Reviewed local operator continuation

The challenged assumption is that an allocated project can remain terminal while
ordinary deployment eventually discovers usable connections. A verified empty
project with local user ADC but no connection is the counterexample: ordinary
planning cannot reach billing, API preparation or a binding.

The allocation remains immutable. Optional
`hosting.scopePreparation.continuation.nativeScope` selects the provider-owned
continuation. Cloud Run accepts `scopeKind: operator-hosting-v1` and an exact
`billingAccountName`. Consecutive saved plans separately authorize initial billing,
API preparation, private image repository creation, optional public helper repository
and optional [GitHub federation](gcp-github-operator-identity.md), then local
nonsecret connection and project binding. No stage
implicitly authorizes the next stage. The original project number, creation time,
parent, ownership labels and retained predecessor digest are checked again.

The API preparation review covers the same fixed 14 APIs. Enabling or using them
may cause Google to create service agents or default service accounts and grant
IAM roles. Hypervibe requests no application workload in this stage; it does not
promise that Google creates no identities or grants. See Google's
[service account types](https://docs.cloud.google.com/iam/docs/service-account-types)
and [service agents](https://docs.cloud.google.com/iam/docs/service-agents).
These provider-managed effects are distinct from the later, separately reviewed
application runtime identities and federation grants.

The optional provider-owned `continuation.isReviewCurrent` predicate prevents
reuse of an obsolete unattempted review. Providers that omit it retain their
existing behavior. An untouched old API proposal remains in the journal while
the same desired source receives a new review and installation plan. Old actions
remain parseable with their original digest for observation and recovery, but
cannot authorize a fresh write. Attempted histories remain authoritative and
read-only; unknown outcomes cannot be bypassed by a replacement review.
A legacy attempt that was definitely rejected is also retained as read-only:
this correction does not migrate its immutable retry authorization to the new
review text. It cannot be renewed by ordinary replanning. No such service-stage
attempt has been observed in the current test project; its retained attempts are
for the preceding billing stage, whose authorization contract is unchanged.

## Provider contract matrix before implementation

| Registered hosting provider | Local operator continuation | Native evidence |
| --- | --- | --- |
| Cloud Run | Explicit capability, user ADC; exact verified allocation required | CRM v3 project lifetime, Billing initial assignment, Service Usage batchEnable |
| ECS | Unsupported in this local allocation capability | Account creation differs; hosted CloudFormation installation remains separate |
| Azure Container Apps | Unsupported in this local allocation capability | Subscription/resource-group installation differs; hosted Entra installation remains separate |
| Railway | Unsupported | No corresponding allocation capability |
| Fly | Unsupported | No corresponding allocation capability |
| DigitalOcean | Unsupported | No corresponding allocation capability |
| Vercel | Unsupported | No corresponding allocation capability |

This matrix covers this local operator bootstrap, not the separate three-provider
customer Connect Cloud flow. No provider inherits support from another adapter.

Official sources, checked 2026-10-25:
- https://docs.cloud.google.com/billing/docs/reference/rest/v1/projects/updateBillingInfo
  assigns billing and can replace a concurrent selection; the existing
  `initial-reviewed-v1` review states that limitation. Unknown responses are read
  back and never cause blind replay.
- https://docs.cloud.google.com/service-usage/docs/reference/rest/v1/services/batchEnable
  accepts at most 20 service IDs and returns an operation. The documented batch is
  atomic, but a missing acknowledgment still does not authorize repetition.
- https://docs.cloud.google.com/service-usage/docs/reference/rest/v1/services/get
  returns the named service's enabled state; denied/malformed reads stay unknown.

Tests use reconstructed native serialized responses through real HTTP clients;
they are not recorded live responses. The local binding stores only project ID, placement and `authMode: default`, never
user tokens, refresh tokens or private keys. These records use the existing connection
store at `<canonical repository>#environment=<encoded environment>`. Selection requires
explicit environment context; repository/global credentials retain their legacy
meaning. Missing context cannot select the new connection. Accepted connections and
project binding survive later ordinary deployment spec edits.
Runtime readers and GitHub workload federation require their own reviewed
lifecycle actions. Existing unrelated connections and bindings are preserved.

## Regression and acceptance evidence

The native billing regression failed three cases with `invalid_contract` before
runtime changes: transient local assignment, lost acknowledgment recovery, and
replaced project lifetime. The real application/SQLite/native-transport regression
then failed because its post-allocation plan had no billing action. After the
shared continuation changes the focused five-suite group passed 40 tests,
including denied API reads, changed billing selection, conflicting connection
preservation, exact-environment adapter/preflight selection and one-write API
acknowledgment recovery. Type checking passed on the combined working tree.

The allocation remains restricted to its original single create/noop action.
Only explicit continuation drivers accept identity/trust actions, and the local
adapter supplies `onlyActionId` so confirmation of one outer action cannot execute
another native action. All prerequisite records are freshly reconciled before
provider writes. The journal permits only one accepted lineage, preserves original
attempt evidence, and refuses competing branches. The hosting-provider roster
requires each named provider's capability decision in ordinary CI.

These regressions are discovered by `npm test`; the committed
`.github/workflows/hypervibe-acceptance.yml` and desired `.hypervibe/spec.json`
run that command and type checking. A separate read-only `hv_ci_status` observation
on 2026-10-25 verified that main requires `Hypervibe / acceptance`, with no
mandatory human review and `enforceAdmins: false`. Offline transport evidence does not certify live billing, Service Usage,
IAM, GitHub federation or full hosted onboarding. No new cloud operation has been
executed or authorized by this implementation work.

A second independently observed SQLite regression found that the historical
`findBestVerifiedMatch(provider)` fallback selected any verified scoped connection
when no scope was supplied. The new environment record was returned without an
environment (one failing test). That no-context fallback now excludes only the new
reserved environment scope; explicit exact-environment lookups and legacy scopes
remain available. The connection repository suite then passed all eight tests.

### Stage reporting after rejected billing (2026-10-25)

The challenged assumption was that the current continuation's readiness also
describes project allocation. Independent live evidence showed one exactly
reviewed initial billing PUT returning HTTP 400, followed by a guarded read of
the same project with `billingEnabled: false` and no billing account. The project
had already been allocated. Apply nevertheless called its allocation unresolved,
and status reported `allocationComplete: false`. Successful billing also inherited
plan/apply/status hints saying billing still needed configuration.

Google's [updateBillingInfo contract](https://docs.cloud.google.com/billing/docs/reference/rest/v1/projects/updateBillingInfo)
and [ProjectBillingInfo fields](https://docs.cloud.google.com/billing/docs/reference/rest/v1/ProjectBillingInfo)
match the retained method, project path and single `billingAccountName` input;
the other fields are output-only. The native 400 body was discarded by the bounded
transport, so its cause remains unknown. This finding establishes a reporting
defect, not the cause of the rejected billing request.

Four reconstructed public-command/SQLite/real-client transport regressions first
failed against the unchanged runtime: rejected billing, verified billing, a denied
project reread, and a replaced project lifetime. The successful case additionally
failed two assertions for the successful apply and no-action plan hints before
those hints changed. Status now follows the immutable predecessor chain and
freshly verifies the exact allocation independently of continuation readiness.
It retains the verified project resource and identifies the current preparation
actions. Denied reads and replaced lifetimes remain unverified. Plan warnings and
apply receipts identify the retained preparation stage. Transport behavior,
failure categories and retry authority are unchanged.

The focused application, local continuation, billing assignment and project
allocation suites passed 48 tests; `npm run typecheck` and `git diff --check`
passed. Rejected-billing recovery still performed exactly one project create and
one billing PUT in the reconstructed transport. These checks run in ordinary
`npm test`, which both the committed acceptance workflow and desired required
check configuration execute. Repository configuration alone does not establish
live branch-protection enforcement.

The previous candidate was built from
`049182c32be0f9b1238570c885a602d40fbdb8bd`, package version `0.1.44`, tarball SHA-256
`290997bcffa41c628fbfdb2e48abd39814b7e92f73d5b60fb2492abc35011b6a`.
Its acceptance revision `ceb81302028e476c0f14dc85ea071205d9a4205c` changed only two
provider test files; production build inputs were unchanged. The
[acceptance run](https://github.com/davejohnson/hypervibe/actions/runs/40247019631/job/121330626037)
passed 7,845 tests (six skipped, one todo). Those gates remain historical baseline
evidence for those exact bytes. This source correction requires a newly built
package and renewed consumer acceptance;
it has not been repacked, published or exercised against live cloud state. Offline
regressions do not establish live billing success or full Connect Cloud readiness.

### Separately reviewed rejected-attempt retries (2026-10-26)

The next counterexample challenged the assumption that local continuation
recovery exposed the shared kernel's rejected-attempt retry contract. A definite
HTTP 400 rejection was retained correctly, but every subsequent local plan
remained a nonbillable, unconfirmed read-only recovery. The installation returned
`retry_confirmation_required` without a reachable public way to review that retry.
Independent requirements are the architecture's exact-action confirmation and
retry safety invariants, together with the observed rejected request; the native
400 cause remains unknown.

A new plan may now carry one exact rejected action/attempt pair for a continuation.
Planning and apply both rerun the provider's authorized plan validation, including
current native identity, billing selection and permissions. The fresh actions and
confirmation flags must match the immutable installation contract; changed
actions fail closed. The outer saved plan identifies each rejected attempt and
retains its billable confirmation requirement. Only that retry and its completed
dependency noops are projected; later actions require a fresh plan. Apply passes
only the current action's exact retry proof to the existing shared kernel. Historical allocation
and recovery plans retain their authority, uncertain writes remain read-only,
and `create-exclusive-v1` project allocation still cannot be replayed.

Before runtime edits, nine of ten new public-command/SQLite/native-transport
regressions failed; the uncertain-write case passed. The correction passed all
ten, then added current-permission and repeated-rejection/stale-plan checks.
Independent review added first/middle GitHub identity rejection and public-reader
grant rejection cases. All three failed before correcting the retry projection
and fresh-review assumptions. GitHub and public-registry planning now verifies
already-completed prerequisites through their existing exact ownership helpers;
unowned resources still conflict.
Coverage includes missing confirmation, changed billing before and after review,
denied project reads, replaced lifetimes, wrong/stale attempts, and old saved
allocate/recovery plans. Fixtures reconstruct responses and unspecified HTTP 400
rejection; they do not diagnose the live billing error or establish live retry
success. No cloud operation or package cutover is authorized by these tests.

Final focused evidence covers all 15 new application scenarios and 29 tests in
the changed provider suites; type checking and diff whitespace validation passed.
Two timed-out existing continuation scenarios passed their focused rerun. The
broader six-suite run's 111 passes and two timeouts are retained as an incomplete
run, rather than reported as an uninterrupted green gate. These regressions remain
in the ordinary acceptance test path; the corrected source needs its own CI and
package/consumer acceptance before replacing the historical candidate.

### API-enablement identity disclosure (2026-10-26)

The challenged assumption was that enabling APIs creates no identities. Google's
IAM documentation above independently states that enabling or using services may
create default accounts or service agents and automatically grant roles. The
existing 14-service batch includes Compute Engine and Cloud Scheduler, making its
no-identities approval text a concrete counterexample. The action reason and both
public warning surfaces now disclose those effects; the API list, requested
permissions and serialized mutation are unchanged.

The normal application/SQLite/real-client boundary first failed two of four
regressions: the new review lacked the disclosure, and a retained old plan still
performed the write. The two historical recovery cases passed. A separate direct
driver assertion also failed because the old action reached authentication and
transport. After correction all four passed, and the whole application file passed
53 tests including definite legacy rejection, lost acknowledgments, billing,
registry and federation continuation. Type checking passed. Historical action
digests remain unchanged; an obsolete direct mutation is denied before credentials
or network access, and untouched old proposals are retained while a new plan is
reviewed. This is reconstructed offline evidence, not proof of live service-agent
creation. No cloud writes occurred. The regression remains in ordinary `npm test`,
which the committed acceptance workflow and desired required check execute; live
branch-protection enforcement was not re-queried for this correction. Previously
verified package and image bytes do not contain this source correction.

### Billing account names in reviews (2026-10-27)

The challenged assumption was that an opaque billing account ID was enough for
an informed account choice. Google's [BillingAccount contract](https://docs.cloud.google.com/billing/docs/reference/rest/v1/billingAccounts)
separately defines `name` as the resource identity and `displayName` as the name
shown in its console. A selected account whose successful GET includes a human
name, followed by a review that omits it, is the counterexample.

Fresh attachment, already-linked and blocked billing reviews now identify the
verified account by its optional human name and exact ID in an existing warning.
Both local `hv_plan` warning surfaces and the hosted escaped warning renderer
already consume that field. Missing, malformed, overlong or control-containing
labels fall back to the ID; exact transient credentials and recognized secret
patterns are redacted before formatting. No account is selected by its label,
and actions, scopes, write authority and historical review digests are unchanged.
Previously saved reviews remain historical; a fresh retry can show a renamed
account without rewriting the original receipt.

Before the runtime change, 13 reconstructed serialized-provider regressions
failed on missing review labels, and the application regression failed its four
fresh/retry public-warning assertions. These checks cover presentation and
credential redaction, not a successful native billing attachment or the cause
of the observed quota rejection. They remain in the ordinary `npm test` gate.

The focused billing-provider and application group passed all 89 tests after the
fix, and `npm run typecheck` passed. No native cloud request was made.

## Service Usage state reads and response size

A read-only operator plan observed Compute's Service Usage `services.get` return
HTTP 200 with the exact resource name and `DISABLED` state, but a 1,389,505-byte
body. Its service configuration exceeded the shared client's 1,048,576-byte
limit. This falsifies the assumption that a complete service configuration fits
that bounded state reader; it does not indicate missing permission or an enabled
API. No API-enable request was dispatched by that observation.

Google documents that [services.get returns configuration and state](https://docs.cloud.google.com/service-usage/docs/reference/rest/v1/services/get),
that [Service.config contains API definitions and documentation](https://docs.cloud.google.com/service-usage/docs/reference/rest/v1/services),
and that the [fields system parameter filters responses](https://docs.cloud.google.com/apis/docs/system-parameters).
The provider now requests `fields=name,state` for local and hosted installation
reads, including inspection, prewrite checks and recovery. The legacy bootstrap
reader also requests `parent,config/name`, preserving its existing identity
checks. Volume prerequisite reads use the same state projection. Enable request
payloads and long-running-operation polling are unchanged; no shared byte limit
was raised.

The legacy read method still exposes Google's explicit `STATE_UNSPECIFIED` value,
but bootstrap previews and secret-writer preparation no longer interpret it as
disabled. They stop before proposing dependent creation or recording an enable
attempt, and the enable client requires a verified `DISABLED` state before POST.
Serialized transport regressions reproduced both the earlier unsolicited POST
and the misleading proposal/journal attempt before these guards were added.

The new normal-CI contract uses reconstructed Service JSON with more than 1 MiB
of synthetic documentation through the real bounded client. The local positive
cases and legacy reader failed before the fix; hosted billing, collection,
deployment and volume regressions also failed before their state reads were
corrected. Missing/unspecified/unknown state, wrong resource identity and a server
ignoring the mask remain unknown and dispatch no enable request. Synthetic field
filtering is offline contract evidence; native support and the subsequent real
plan must still be verified with the corrected package.

The final focused provider, legacy caller and local command group passed all 230
tests in nine suites. The ordinary `npm run typecheck` passed against a clean
snapshot containing only this change, isolating concurrent publication work.
These regressions remain in the normal `npm test` acceptance path; both the
committed acceptance workflow and desired required-check configuration invoke it.
