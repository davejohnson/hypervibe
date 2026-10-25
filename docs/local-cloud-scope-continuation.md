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
