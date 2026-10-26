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

The previous candidate remains source
`ceb81302028e476c0f14dc85ea071205d9a4205c`, package version `0.1.44`, tarball SHA-256
`290997bcffa41c628fbfdb2e48abd39814b7e92f73d5b60fb2492abc35011b6a`.
Its [acceptance run](https://github.com/davejohnson/hypervibe/actions/runs/40247019631/job/121330626037)
passed 7,845 tests (six skipped, one todo). Those gates remain historical baseline
evidence for those exact bytes. This source correction requires a newly built
package and renewed consumer acceptance;
it has not been repacked, published or exercised against live cloud state. Offline
regressions do not establish live billing success or full Connect Cloud readiness.
