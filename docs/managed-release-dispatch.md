# Managed release dispatch and recovery

The assumption being challenged is that retrying a failed workflow dispatch is
safe because a later run can be found by commit SHA. A lost HTTP acknowledgment
can already have started a deployment. Same-SHA runs do not establish dispatch
identity, and artifact names do not establish deployed source or runtime identity.
The SQLite/application regression observed two dispatches after a lost response.

GitHub's already-selected API version is 2026-03-10. The pinned official OpenAPI
at `test/provider-contracts/github/dispatch-source.json` specifies a 204 response
by default and a 200 native run receipt when `return_run_details: true` is sent.
The response identity is verified against the exact repository. An empty,
malformed or lost response remains uncertain and must not trigger another POST.

A local compare-and-swap journal persists the exact repository, environment,
workflow, branch, source SHA, workflow contracts and deployment contract before
sending the request. The attempt's random nonsecret ID is a declared input and
part of the reviewed managed workflow run name. The renderer revision change
uses normal workflow publication/review; old workflows are not silently edited.
After restart, exact returned run IDs or uniquely matching operation IDs permit
read-only recovery. Ambiguous/absent listings remain pending. A completed native
failed run permits only a separately planned retry naming the prior attempt.
An exact documented GitHub permission-denial response is recorded as rejected
and also requires a freshly planned retry; rate-limit, malformed and transport
errors retain uncertain intent. [GitHub's error contract](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api?apiVersion=2026-03-10)
distinguishes insufficient-token-permission errors from other 403 responses.
Null and unsupported native conclusions never authorize another dispatch;
supported conclusions follow the [workflow-run contract](https://docs.github.com/en/rest/actions/workflow-runs?apiVersion=2026-03-10#list-workflow-runs-for-a-repository).
Changed source or authorization cannot erase an uncertain attempt. If source
changes while a prior run is pending, Hypervibe observes that exact prior run
read-only and records native completion without accepting its deployment for
current source. A fresh plan must name that completed attempt before dispatching
new source. Nonsecret credential-operation hashes distinguish successive
credential rollouts at the same source commit.

Completion reuses the common trusted v4 release-artifact validator: the exact
managed producer files, source, workflow attempt, repository, environment,
program, deployment contract and native targets must match. Native lifetime
proof remains an additional requirement for installer-prepared handoff. Stored
journal status and artifact metadata alone do not prove a deployment.

The registered CI provider matrix is GitHub Actions and GitLab CI. This change
covers GitHub's managed post-release dispatch used by AWS, Azure and GCP. GitLab
uses its separate native pipeline API, and broker-authenticated deployment and
this post-release path remain explicitly unsupported there; it does not inherit
GitHub nonce or response semantics. Existing ordinary provider behavior is not
new live acceptance evidence. Legacy uncorrelated attempts are never adopted
from a name or silently retried.

Recovery records contain no credentials or dispatch input values. They are
local authority, excluded from repository export, and cannot be imported to
replace local history. Tests use reconstructed official HTTP responses and
synthetic workflow lifecycle observations; no live GitHub dispatch is performed.


Observed regression evidence:

- Lost acknowledgment originally caused two POSTs; the SQLite restart regression
  now observes the one exact run using its retained operation ID.
- Source/ref changes during credential preparation, source/native-binding changes
  during artifact verification, a later credential operation at the same SHA,
  and null/unknown native completion originally crossed the wrong authority
  boundary. Each was observed RED before its corresponding correction.
- Current checks cover real serialized native dispatch requests/responses against
  the pinned official opt-in schema, real SQLite compare-and-swap/restart,
  emitted release evidence consumed by the shared trusted parser, concurrent
  calls, duplicate operation matches, explicit denied/retry paths, stale plans,
  repository export/import custody, and a frozen revision-7 workflow requiring
  publication. Lifecycle GitHub observations are synthetic, not live recordings.
- The focused integration group passes 407 tests in 15 suites, and TypeScript
  checking passes. All cases use normal Vitest discovery; the committed
  `Hypervibe / acceptance` workflow executes `npm test` and the desired required
  checks include that name. Live branch-protection enforcement was not inspected.

No live GitHub dispatch or provider deployment was performed for these changes.
Legacy workflows need the reviewed renderer migration before a new managed
dispatch. An uncertain attempt whose operation cannot be uniquely observed stays
pending; absence from a listing never licenses resubmission. GitHub can change a
branch or permission after the last observation, so native dispatch/receipt and
final proof remain separate checks rather than a claimed cross-service atomic
transaction. The journal deliberately contains no administrator token, credential
input, environment value or raw provider response.
