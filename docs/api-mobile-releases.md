# API compatibility and iOS releases

Web/server releases and mobile builds are independent. A successful managed
server release starts an inexpensive iOS eligibility job. Only changes that
affect the mobile build proceed to protected jobs and TestFlight. Publishing an
App Store version remains an explicit, confirmed operation over a tested build.

These features currently use GitHub Actions. API protection rejects direct,
provider-native and other CI release paths rather than silently omitting checks.
Nothing in this policy creates application routes or an in-app update screen.

## Declare mobile inputs

Within an environment's existing `ios.release` declaration:

```json
{
  "trigger": "after-server-deploy",
  "services": ["api"],
  "apiVersion": "v1",
  "build": {
    "workingDirectory": ".",
    "inputs": ["apps/ios", "packages/shared"],
    "command": "make ios-ipa",
    "ipaPath": "build/App.ipa"
  },
  "testflight": { "groups": ["beta"] }
}
```

`apiVersion` is required when the environment declares API protection; omit it
otherwise. Input paths are literal repository-relative files or directories,
not globs. Omission watches `build.workingDirectory` (default `.`), so existing
root builds conservatively rebuild until their inputs are narrowed. Include all
shared code used by the app. Root dependency/signing/build configuration files
and the generated iOS workflow are always watched. The semantic mobile spec is
fingerprinted, so an unrelated web-only spec edit need not rebuild the app.

The environment-free eligibility job verifies the successful server run and
its exact deployed source, then compares all changes since the last proven beta.
It checks both names of renames and deleted files. A first release, expired or
unknown baseline, divergent history, changed workflow, or incomplete comparison
builds conservatively. An invalid server/source contract blocks before Apple
credentials or approval. A skipped run does not replace the last successful beta
baseline. `force=true` on a manual `hv_ci_trigger` dispatch bypasses only
the relevance decision; it cannot bypass release provenance.

Mobile jobs use a separate app-scoped queue. They cannot occupy the server
release queue. Apps sharing one bundle ID in the repository share the mobile
queue to reduce build-number collisions. Other repositories and external
uploaders can still race; upload identity safeguards remain in effect.

## Declare supported API versions

```json
{
  "api": {
    "service": "api",
    "versions": {
      "v1": {
        "path": "/v1",
        "contract": "api/contracts/v1.json"
      }
    },
    "consumers": {
      "web": { "versions": ["v1"] },
      "ios": { "versions": ["v1"] }
    },
    "compatibility": {
      "command": "npm run api:compatibility"
    }
  }
}
```

The service must be an existing web workload. The project declares its runtime;
compatibility checks inherit its installation command unless they explicitly
provide `compatibility.installCommand`. Commands run from
`compatibility.workingDirectory` (default `.`), before migrations and provider
release writes. They receive:

- `HYPERVIBE_API_BASELINE_DIR`: immutable snapshots from the verified earlier
  release, or an empty directory on a proven first managed release.
- `HYPERVIBE_API_CANDIDATE_DIR`: the proposed version ledger and contract snapshots.
- `HYPERVIBE_API_ENVIRONMENT`: the target environment.

Candidate and existing-baseline directories contain `hypervibe-api-release.json` and
`contracts/v1.json`, etc. The command must fail when the candidate changes an
existing supported contract incompatibly or breaks a supported client's
behavior. Include request/response shapes, auth, defaults, errors, pagination,
and data compatibility in application tests. Exercise actual versioned handlers;
returning any non-404 response is insufficient. Production web and installed iOS
client fixtures should remain covered even after new clients ship.

Contracts are self-contained JSON documents, with at most 32 versions and a
1 MiB aggregate evidence/snapshot limit. External/dynamic references,
symlinks, malformed evidence and changed snapshots block the release. Hypervibe
enforces the ledger and test result; it does not infer semantic compatibility
from a version label, file paths, or an OpenAPI document alone. Contract documents
must not contain secrets: snapshots are stored in repository CI artifacts, whose access follows the repository.

An API policy first has an isolated `hv_plan`/`hv_apply` stage that records its
version ledger in bindings. Follow it with ordinary workflow reconciliation.
`hv_status` reports policy drift. Removing the whole declaration or a retained
version blocks instead of disabling protection. The workflow lock includes the
policy and API renderer revision. Changing the API policy does not force a mobile
build merely because the server SHA changes.

Routine compatible changes remain within `/v1`. For a breaking change, add
`v2` with `/v2` while keeping the working `/v1` handlers and contract. Set v1's
`status` to `deprecated` when appropriate; this never expires it. A version can
remain supported indefinitely.

Retirement is a separate reviewed decision. Remove active consumer references,
retain the version with `status: "retired"`, and declare
`retirement: { "id": "retire-v1-2027", "reason": "..." }`. The isolated policy
action requires its exact action ID confirmation. The application must already
provide the intended retired-version/update behavior; policy acceptance does
not change any routes. Tombstones cannot be removed, edited or revived. Raising
a minimum supported app version and implementing an update-required screen
remain application work and should be tested before retiring its API.

## Promote the tested app

Set production's `ios.release.promoteFrom` to the beta environment and its
`trigger` to `manual`. Bundle ID, platform, build/signing settings, and API version
must agree. Production does not rebuild the binary for submission. The beta must
already contain production-capable backend configuration; it retains everything
built in the source environment. Matching secret names do not prove matching
values or endpoints. Avoid Apple's **TestFlight Internal Only** export option
when the build will later be submitted to the App Store.

Use `hv_ci_status` to inspect releases, then `hv_appstore_submit` to preview the
exact app version, Apple build, beta run and target server release. The preview
returns confirmation inputs containing the selected run IDs and a fingerprint.
Confirmation revalidates those exact identities. CLI and MCP share this flow.
Prepare App Store metadata and attach that exact processed build first; Hypervibe
does not substitute whichever build happens to be attached. Apple review and
store rollout remain separate from GitHub approvals and TestFlight beta review.

The server release must still be the latest proven target deployment, including
retries of older runs. History is bounded; incomplete observation blocks. An older
beta can accompany a newer server SHA only with matching versioned API evidence;
otherwise submission blocks. Neither path rewrites the beta's source SHA.
Changed contract bytes are conservatively rejected for cross-commit reuse even
when an application author considers them compatible. A new beta can establish
fresh evidence without inventing compatibility proof.

## Evidence and limits

API-protected server releases publish a companion artifact bound to the exact server
release bytes. Unknown history, incomplete pagination, expired artifacts and
potentially partial deployments block. A failed compatibility check can be
retried only when immutable workflow/job evidence proves no release mutation
was reached. Failed or cancelled work that may have deployed requires evidence
resolution before another baseline is selected.

Existing deployments without API companion evidence require a reviewed baseline
migration; they are not treated as a new empty application. API-protected rollback
is blocked until retained-version compatibility can be proven for the old image.
Existing v1 iOS manifests require a new beta using the v2 evidence producer before
submission through these stronger checks. These limitations preserve evidence
rather than guessing from timestamps or build numbers.

Regression tests execute generated shell/JavaScript and synthetic HTTP transport
responses in ordinary `npm test`. They do not establish live GitHub/Apple
permissions, code-signing compatibility, app runtime behavior,
or a successful production rollout. No live deployment or Apple submission is
part of this implementation's local acceptance.

Independent references: [GitHub environment protection](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments),
[GitHub compare response limits](https://docs.github.com/en/rest/commits/commits#compare-two-commits),
[GitHub artifact download contract](https://docs.github.com/en/rest/actions/artifacts#download-an-artifact),
[API compatibility principles](https://google.aip.dev/180), and
[Apple beta/release distribution](https://developer.apple.com/documentation/xcode/distributing-your-app-for-beta-testing-and-releases).
