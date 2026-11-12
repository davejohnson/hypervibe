# Provider conformance

Provider support requires a disposable live fixture that creates its declared
resources through Hypervibe, serves the expected application response, updates
without replacement, converges to a noop, tears down, and independently confirms
the absence of every recorded native resource. An empty plan, missing binding,
HTTP health check alone, or passing offline tests cannot establish that result.

Normal CI runs the pinned [provider API contracts](../test/provider-contracts/README.md),
provider matrix checks, and behavioral lifecycle-harness tests. These checks do
not use cloud credentials or create infrastructure. Existing scheduled checks
remain read-only; this change does not enable scheduled billable fixtures.

## Implemented live profiles

The explicit registry is
[`live-fixture-profiles.ts`](../test/provider-conformance/live-fixture-profiles.ts).
The ordinary CI guard requires a profile for each non-planned infrastructure
provider contract. A profile records intended coverage; it does **not** promote
provider status or assert that a live run has passed.

| Profile | Declared disposable resources | Release and verification |
| --- | --- | --- |
| `gcp-engine` | One public Cloud Run web service and its public-invoker IAM member | Committed local fixture archive through the installed Hypervibe release path; exact JSON body and `create`/`update` revision; encrypted engine-state identity projection and exact Cloud Run GET after teardown |
| `railway` | Web service, PostgreSQL, Redis, object bucket, associated volumes, PostgreSQL-backed queue wiring | Prepared repository and managed GitHub workflow, exact commit and release artifact; exact JSON revision and SQL probe; complete native project service/volume/bucket inventory before teardown and after deletion |
| `cloudflare-load-balancer` | Health monitor, origin pool and hostname load balancer | Two prepared dedicated Railway origins are retained platform prerequisites; exact fixture body through the load balancer; in-place health-monitor update; registered exact-ID reads confirm all three resources absent |

The GCP profile is deliberately **web-only**. It does not prove Cloud SQL,
Memorystore, storage, queues, secret containers, scheduled jobs, or their complete
live teardown. Adding one to its fixture must first add an exact native absence
reader; unknown resource types fail closed. Its project-level APIs, IAM,
Artifact Registry repository, runtime identity, and build storage belong to a
separately prepared test platform and remain after the fixture environment is
empty. This is not a claim that an entire cloud project or account was deleted.

Railway queue wiring uses the declared PostgreSQL database; it does not create a
provider queue resource. The fixture checks that database and every native
service, volume and bucket in its dedicated initially empty Railway project.
It does not claim every Railway workload kind, custom-domain, data-transfer or
backup feature has passed live.

The Cloudflare profile refuses any mutation outside its load-balancer resources.
Its dedicated origins must already be serving the fixture with revision `live`
through the supported managed release workflow. Origin services are not created
or deleted by this profile. Their lifecycle is covered separately by Railway's
profile. The Cloudflare inventory retains exact account/zone scope and IDs even
when apply fails or removes local bindings; unresolved creation without a saved
ID remains a cleanup failure.

AWS and Azure infrastructure remain planned and explicitly unavailable. Legacy
GCP adapter lifecycle registrations are also planned: GCP live deployment uses
the separate OpenTofu engine profile. Cloud SQL resilience/restore-drill workflows
are unavailable after the engine cutover. Selecting these unavailable profiles
fails; they are never counted as passing live fixtures.

## Opt-in runner and dedicated platform

Build and select exactly one profile:

```sh
HYPERVIBE_LIVE_PROFILE=gcp-engine npm run test:providers:fixtures
HYPERVIBE_LIVE_PROFILE=railway npm run test:providers:fixtures
HYPERVIBE_LIVE_PROFILE=cloudflare-load-balancer npm run test:providers:fixtures
```

Selection is explicit. Missing credentials, repository access, marker, or platform
setup fails the selected run instead of silently skipping it. Ordinary `npm test`
skips all live runners unless their selector is set. Do not set live selectors in
ordinary or scheduled CI without separate credentials, budget and approval setup.

All profiles use the installed CLI for infrastructure changes:
`hv_spec` → `hv_plan` → exact confirmed `hv_apply`, then the supported release
path. Provider calls in the harness are read-only. No cloud CLI, direct provider
creation/deletion, manual state edits or alternate deployment script is used.

Prepare a **dedicated reusable test platform** through Hypervibe first. It must
have working scoped connections and exact ownership in the supported lifecycle
state. Existing resources without current engine ownership are a prerequisite
blocker, not permission to adopt them. A legacy pilot with matching names is not
automatically eligible. Keep its installed Hypervibe database, encrypted state,
secret store, and the disposable checkout in persistent directories.

`HYPERVIBE_LIVE_FIXTURE_MARKER` names an operator-reviewed JSON file declaring
that exact platform is dedicated to these tests:

```json
{
  "version": 1,
  "purpose": "disposable-provider-conformance",
  "profile": "gcp-engine",
  "project": "the-dedicated-hypervibe-project",
  "internalProjectId": "the-existing-hypervibe-project-id",
  "nativeProjectId": "the-existing-gcp-project-id",
  "repository": "owner/dedicated-fixture-repository",
  "region": "us-central1",
  "runtimeServiceAccountEmail": "runtime@the-existing-gcp-project-id.iam.gserviceaccount.com"
}
```

The runner checks every field against the actual selected target. For Railway
and Cloudflare use the respective profile ID, omit `region` and `runtimeServiceAccountEmail`, and include
`nativeEnvironmentId` for the prepared Railway environment. Cloudflare uses its
prepared Railway project as `nativeProjectId`; its separate cleanup journal
records the exact Cloudflare account and zone. A marker cannot bypass a blocked
Hypervibe plan or confer ownership on existing resources.

## GCP preview, continuation and cleanup

Required inputs are `HYPERVIBE_LIVE_PROJECT`,
`HYPERVIBE_LIVE_DATA_DIR` (existing prepared state),
`HYPERVIBE_LIVE_FIXTURE_DIR` (a new absolute persistent directory), the marker,
and the marker’s exact native project, region and runtime service-account identity.
The runner reads the existing **verified repository-scoped connection** from that
state directory and verifies its native project and runtime identity against the
marker. A global connection is insufficient. Bootstrap prepares that scoped
connection; the user does not export credential JSON or copy secret values.
Credentials and raw engine state never become evidence artifacts.

The default mode is **preview only**. It creates a unique `fixture-*` environment
in the desired specification, preserving other environments, commits the tiny
local application fixture, and saves `fixture-plan.json`. That file contains the
exact persisted Hypervibe plan ID and safe action metadata. Preview does not
apply or release, and is not a passing lifecycle result.

Review the exact plan, intended lifecycle, billable actions, and disposable data
scope before continuation. Continue the same checkout and journal with:

```sh
HYPERVIBE_LIVE_PROFILE=gcp-engine \
HYPERVIBE_LIVE_MODE=run \
HYPERVIBE_LIVE_AUTHORIZE_LIFECYCLE=1 \
HYPERVIBE_LIVE_APPROVED_PLAN_ID='<the-reviewed-saved-plan-id>' \
npm run test:providers:fixtures
```

The lifecycle flag explicitly authorizes the declared create/release/update/teardown
sequence. The first apply consumes that saved plan without replacing it with a new one.
The application rejects expired or stale plans. This opt-in lifecycle then
plans/applies the declared update and teardown with exact action IDs. The initial
preview freezes service/IAM addresses and native identity fields. Every later plan
must stay inside those exact addresses and allowed stage operations before apply;
replacement, adoption, extra services or IAM changes require another reviewed
workflow and are refused by the fixture. A failed
prerequisite requires a new reviewed preview, not automatic migration or
resource recreation.

The journal saves deterministic, scoped service identities from the reviewed
configuration before apply, then projects only allowlisted `address`, `type`
and native `id` from readable encrypted engine state after attempted applies.
It independently checks those native identities afterward. Missing, ambiguous
or unreadable evidence stops cleanup and preserves recovery state.

## Railway and Cloudflare prerequisites

Railway additionally requires `HYPERVIBE_LIVE_REPOSITORY_WORKTREE`,
`HYPERVIBE_LIVE_DATA_DIR`, `HYPERVIBE_TEST_GITHUB_REPOSITORY`,
`HYPERVIBE_TEST_GITHUB_API_TOKEN`, `HYPERVIBE_TEST_RAILWAY_TOKEN`, and the exact marker.
The test repository must contain committed files from
[`fixture/`](../test/provider-conformance/fixture/) and a committed normalized
`.hypervibe/spec.json` declaring the managed profile in
[`provider-matrix.ts`](../test/provider-conformance/provider-matrix.ts):
`production`, public `web`, PostgreSQL, Redis, `files` bucket in `iad`, `jobs`
queue wiring, revision `create`, and branch/CI deployment on `main` with automatic
deployment disabled. Generate the normalized spec with Hypervibe. Prepare the
native project/environment before the run; all native services, volumes and
buckets must initially be absent. Do not use an application project.

Railway also defaults to preview-only and saves
`railway-<project>-fixture-plan.json` in the persistent state directory. Review
that exact initial plan, then set `HYPERVIBE_LIVE_MODE=run`,
`HYPERVIBE_LIVE_APPROVED_PLAN_ID` to its saved ID, and
`HYPERVIBE_LIVE_AUTHORIZE_LIFECYCLE=1`. Later actions are restricted to the typed
web/database/cache/bucket/queue fixture and its exact managed repository/workflow
operations; replacement, extra resources during update, and creation during
teardown are refused. Cleanup-only retains the same explicit lifecycle consent.

The runner publishes required managed workflow changes through Hypervibe's
reviewed PR flow, waits for those PRs to be reviewed and merged, dispatches
`deploy-railway-production.yml` at the fixture's exact commit, and checks its
release artifact and running response for both revisions. Repository access,
Actions credentials and an available reviewer are fixture prerequisites.

Cloudflare requires a prepared checkout/state directory and marker, the same
Railway access for its origins, `HYPERVIBE_TEST_GITHUB_REPOSITORY`,
`HYPERVIBE_TEST_CLOUDFLARE_API_TOKEN`, optional
`HYPERVIBE_TEST_CLOUDFLARE_ACCOUNT_ID`, and
`HYPERVIBE_TEST_CLOUDFLARE_LOAD_BALANCER_HOSTNAME` under a dedicated test zone.
The hostname must begin `hv-conformance-`. Its `conformance` environment must
already declare and serve `origin-a` and `origin-b`; origins must be public HTTPS
endpoints and return the fixture JSON body with revision `live`. The initial
platform plan must be a noop before adding the load balancer. A new run requires
`HYPERVIBE_LIVE_AUTHORIZE_LIFECYCLE=1` for its declared creation, monitor update and
exact cleanup; resume uses the saved journal for cleanup only.

## Failure recovery and evidence

GCP and Railway share the tested lifecycle driver in
[`lifecycle-live-harness.ts`](../test/provider-conformance/lifecycle-live-harness.ts).
Cloudflare uses its exact-ID cleanup driver in
[`cloudflare-cleanup-harness.ts`](../test/provider-conformance/cloudflare-cleanup-harness.ts).
All preserve private durable inventory before deletion and after attempted
applies. Normal failures and handled interruptions attempt dependency-ordered
cleanup. A hard process kill can require a separate cleanup run; the journal and
encrypted state remain available. Unknown provider reads, partial inventory,
unrecorded creates, or a still-present resource fail cleanup. No empty local
state is accepted as proof of provider absence.

For GCP/Railway, rerun the same profile, target, checkout, credentials and journal
with `HYPERVIBE_LIVE_CLEANUP_ONLY=1`. Cloudflare detects its existing journal and
runs cleanup only. Do not delete or edit recovery state to make a run pass. Keep
failure evidence for diagnosis. A new fixture uses a new dedicated journal only
after prior cleanup is independently verified.

A completed GCP/Railway journal must record all four checks: created, noop,
updated, and provider-confirmed absent. A preview or cleanup-only run cannot
supply missing create/update proof. Cloudflare requires its complete resource
checks plus successful create/update/health assertions. Record the date, tested
commit, exact profile, safe native inventory and outcome with live evidence;
never include tokens, credential files, raw provider logs, full plans or state.

No new live run is established by the harness implementation alone. Missing
access remains explicit. Broader provider capabilities require their own declared
fixture resources, native absence readers and successful live evidence before
support claims expand.
