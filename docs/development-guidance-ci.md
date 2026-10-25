# CI, releases, and execution evidence

Read before changing managed CI, release/task execution, workflow publication, promotion, or iOS release behavior.

These are normative maintainer rules, complementary to `ARCHITECTURE.md`,
which remains the infrastructure model's source of truth. Load only the sections
relevant to the task. Paths in code spans are relative to the repository root.

Related contracts: [CI And Push Deploys](../ARCHITECTURE.md#ci-and-push-deploys), [GitHub infrastructure](github-infrastructure.md), [GitLab integration](gitlab-integration.md), and [API/mobile releases](api-mobile-releases.md).

Stable rule IDs preserve the original guidance and are mapped in
[the migration audit](development-guidance-migration.json). These files are
for developing Hypervibe; the distributed user workflow lives in
[`skills/hypervibe`](../skills/hypervibe/SKILL.md).

## DG-056

Generated CI may build an application image and update or execute exact provider resources that a reviewed apply already created and bound. It must never create a same-named registry, service, job, database, or other infrastructure resource on demand.

## DG-057

For auto-deploy workflows, a first push with no applied desired-state marker must end as a neutral no-deploy bootstrap. Once a marker exists, any desired/applied contract mismatch remains a hard failure until the exact plan is applied.

## DG-062

For existing-project CI savings, follow the project template's [adoption guide](https://github.com/davejohnson/project-template/blob/main/docs/ci-efficiency.md) and [testing skill](https://github.com/davejohnson/project-template/blob/main/.agents/skills/project-template-testing/SKILL.md). Preserve repository-owned setup, required check names, and full-suite gates; do not duplicate those checks with managed `github.actions`. Keep deployment/settings changes in spec/plan/apply. The unreleased `deploy.promotionTests.workflow` integration must always run the full candidate suite; opt into `packageReadToken` only for private packages and publish support before adoption.

## DG-063

Evaluate CI conditions only where their required context exists. Execute generated gates and compare committed check workflows with desired triggers/commands; a spec-only assertion does not prove the safeguard is running.

## DG-064

Treat a managed GitHub Actions workflow's reviewed content hash plus semantic input hash as its lock. Environment values and generator implementation changes alone must not rewrite a deployed workflow; change the renderer revision for an intentional template migration. When stable provider identities need both workflow publication and runtime updates, publish and re-observe the workflow in its own plan stage before authorizing provider mutations.

## DG-065

Require a managed GitHub Actions deploy branch to equal the provider-observed repository default branch. GitHub registers `workflow_dispatch` workflows on the default branch; publishing only to another branch creates a workflow that cannot be dispatched reliably.

## DG-066

Treat a project-level generated CI program as one shared multi-environment contract. Publish it only when every desired target has complete bindings from its selected provider, retain the reviewed proposal on every matching environment binding until teardown can finish in any order, and retire only variables whose stored ownership hash still matches after the replacement program is accepted.

## DG-102

For push deploys, `deploy.trigger: "ci"` is the portable default. Provider-native deploys are explicit opt-in and may require provider-specific external app access.

## DG-103

Dispatch Hypervibe-managed CI deploys only through `hv_ci_trigger`. Inspect them through `hv_ci_status`: list definitions/workflows, then runs, jobs, and bounded log tails as needed, followed by `hv_health` after success. Do not dispatch, monitor, or inspect them with `gh`, code-host connectors/apps, browser/UI inspection, or direct CI/provider APIs; if `hv_ci_trigger` or `hv_ci_status` is blocked, stop and report its connection/error guidance.

## DG-104

Automated repair must fail closed when its declared failure evidence is absent or incomplete. Never invoke the repair agent or publish a patch from an empty artifact download; keep runtime labels and pull-request metadata derived from the configured agent instead of hardcoding a model name.

## DG-114

Portable execution authority must compare its source against a current, strict non-secret binding export. Refresh that export on component creation, replacement, binding updates and removal; checking only the provider name permits an obsolete resource to keep producing apparently healthy receipts. For an already-authorized portable storage binding, re-observe its exact native identity and account/project scope; a checkout's local ID must not replace either.

## DG-124

A shared container image default is distinct from each workload's runtime command. Preserve explicit web/worker/cron commands when selecting a generated image default; test the real spec-to-workflow path with different workload commands and execute the emitted Dockerfile-generation shell. Never require workers to use the web command just to build a shared image.

## DG-125

Generated-workflow tests must execute the emitted shell and JavaScript against a realistic multi-service fixture. Substring assertions may supplement those contract tests, but cannot stand in for proving target selection, provider calls, evidence writing, rollback, and fail-closed behavior.

## DG-126

Keep workflow-source provenance separate from deployed-source identity. A dispatch input can select a different application commit than the workflow run's head SHA. Discover releases by their versioned artifact identity, correlate artifact metadata with its actual successful managed run, then validate the requested deployed commit in the evidence contents. Authenticate that producer independently of public artifact fingerprints: require the configured source branch, same repository, supported event, completed success, correlated artifact/run metadata, and workflow-commit membership in the exact branch ref. A dispatch may name a tag, so an unqualified branch label alone is not trust. Cover untrusted same-path producers, differing commits, and bounded pagination through the emitted consumer.

## DG-127

Version release evidence and operational receipts from their shared validators and migrate every producer, generated consumer, runtime consumer, and fixture together. Enumerate success gates as well as failure alerts; execute actual producer results through every generated consumer instead of maintaining separate hand-written success fixtures. Validate historical provenance against the exact source revision; compare current program/resource compatibility separately so a compatible env-only update preserves immutable rollback. Execute a generated consumer against producer-shaped evidence so stale schemas cannot pass on matching mocks.

## DG-128

The managed iOS runtime (`templates/ios/hypervibe-ios-release.mjs`) must validate server evidence before provider effects and must never reuse an existing Apple build solely by version/build number. Without original-upload identity proof, retries and collisions fail closed before distribution or success evidence. Advance the iOS-only renderer revision in `ios-release-workflow.service.ts` for intentional runtime migrations; the shared workflow input hash must preserve server-only projects. Keep source/emitted-runtime HTTP-boundary regressions and the deliberately old-contract workflow-lock regression in ordinary acceptance tests.

## DG-129

The managed iOS runtime owns build-number selection from a complete paginated App Store build listing; unknown, malformed, unsafe, or exhausted evidence must block rather than guess. A checkout-free preparation job supplies `HYPERVIBE_BUILD_NUMBER` to the credential-free project build job, and the emitted IPA validator must require that exact `CFBundleVersion`. Projects consume the number without choosing it or receiving App Store credentials. Selection is not an atomic reservation; retain collision guards on retries. Keep executable emitted-command and IPA-plist mismatch regressions in ordinary acceptance tests and coordinate project handoff support before publishing this workflow migration.

## DG-130

Keep generated iOS `run` scripts within GitHub's 21,000-character limit. Embed the managed runtime as step-local data, not a growing shell literal; execute the emitted materializer and enforce the limit in the ordinary workflow regressions.
