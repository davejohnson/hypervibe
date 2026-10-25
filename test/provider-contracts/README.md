# Pinned provider API contracts

Run `npm run test:providers:api-contracts`. These tests also run in the ordinary
`npm test` acceptance gate. No credentials, schema downloads, or provider
resources are used. The existing `test:providers:upstream-contracts` command
and `scripts/check-railway-upstream-contract.mjs` remain offline compatibility
entrypoints for already-reviewed managed workflows, not upstream drift checks.

## Sources and coverage

`cloud-deployment-provider-roster.test.ts` pins every hosting provider against the
[keyless deployment contract](../../docs/connect-cloud-deployment-contract.md).
The shared deployment/install/session suites distinguish provision, release and runtime
authority; emitted CI tests execute broker exchanges and native registry transports.
All run through ordinary Vitest discovery in `npm test`. GCP native scoped deployment
installation, fresh Azure creation, GitLab broker authentication, AWS template publication
and all three new-customer live walkthroughs remain explicit gates. Callback, renderer
or registry presence does not establish a complete first deployment.

Azure Connect Cloud preparation, federation, historical recovery, runtime readers and
migration preservation are covered by `azure-cloud-installation.test.ts`,
`azure-federated-auth.test.ts`, `azure-runtime-identities.test.ts` and the real
Azure adapter reference suite. See [assumptions, official contracts, observed
regressions and unresolved live gates](../../docs/connect-cloud-azure-evidence.md).
`runtime-identity-provider-roster.test.ts` enforces the named hosting registry
review; shared runtime-access tests exercise saved plans and SQLite recovery.
The create-only probe tests are synthetic acceptance criteria, not evidence
that Azure honors the proposed header. All run in the ordinary `npm test` gate.
New Azure connect/migration plans are blocked before registration/group writes;
native first group/vault/UAMI writes and first ACA workload creation remain blocked. Azure new
customer onboarding is not ready for live. Positive historical fixtures do not
establish successful installation of a new customer.


`secret-container-setup.test.ts` and the application/service suites with the same
prefix enforce the [empty container setup contract](../../docs/secret-destination-delivery.md#empty-container-setup).
The named matrix admits only GCP setup while preserving separate AWS/Azure
delivery and runtime-reference capabilities. Independent Secret Manager and CRM
contracts drive real synthetic REST requests; command tests use migrated SQLite
and the real planner/executor. Initial regressions failed because the new scope
fell through to ordinary deployment planning, discovery was absent, confirmation
review omitted destination identities, and pre-create checks accepted changed
local scope/source. The corrected tests run in normal `npm test`; no live
provider call or credential value is involved.

`src/application/__tests__/seed-registry-scope.api-contract.test.ts` exercises
database seed dispatch through real encrypted connection selection and Railway
HTTP serialization. Its synthetic responses execute against the pinned official
Railway SDL, including `ServiceInstanceUpdateInput.registryCredentials`.
[Railway's private-registry contract](https://docs.railway.com/builds/private-registries)
requires service image-pull credentials; Hypervibe's project-isolation contract
determines which saved credential may be supplied. Exact repository, matching
wildcard, intentional global fallback, missing/non-GitHub context, and failed-task
reapply are covered in normal `npm test`. This validates selection and wire
compatibility, not live token permissions, image boot, or the cause of an observed
customer task failure.

The [scoped secret contract](../../docs/scoped-secret-updates.md) reviews all
seven hosting providers and distinguishes native capabilities from implemented
admission. `scoped-secret-provider-contracts.test.ts` pins that roster and the
explicit deferred-write capability. The application lifecycle regression uses
the real Railway client and pinned GraphQL transport to cover exact environment
identity, additive writes, no deployment, encrypted plan inputs, stale plans,
unknown reads, lost write acknowledgments, delayed visibility and acceptance
recovery. This is synthetic offline evidence, not a successful live key rotation.

The [shared recovery contract](../../docs/recovery-contract.md) records the
official recovery-model review for all eight database and seven hosting
providers. `recovery-provider-contracts.test.ts` checks explicit registry coverage,
actual capability declarations, unsupported planning and emitted rollback recipe
capabilities. Shared source/point tests check representation; they do not claim
unimplemented adapters or live recovery. Existing provider transport and lifecycle
tests remain the executable API boundary for implemented operations.

`daily-backup-provider-matrix.json` records official-source design evidence for
all eight database, seven hosting/mount and four object-storage providers.
`daily-backup-provider-contracts.test.ts` checks that roster and the complete
implemented policy ports against registry flags. Unsupported rows are explicit
Hypervibe implementation gaps; the matrix does not certify live backup coverage
or replace the implemented adapters' transport-contract tests. See
[daily backup defaults](../../docs/default-backup-policy.md).

`managed-recovery-provider-matrix.json` separately reviews the seven hosting
adapters' private helper execution and all four storage adapters' retained-copy
transports. Its roster test checks the private helper capability flags and exact
lockfile SDK versions/integrities. S3/Railway and Azure tests execute their real
SDK serialization with injected HTTP transports; GCS tests inspect JSON API
conditions and the raw HTTPS media path, including compressed stored bytes.
These are documentation-based wire assertions, not checked-in provider schemas
or live API certification. They cover conditional reads, create-only writes,
exact conditional deletion, pagination/revision metadata and streamed content.
Railway's general S3 compatibility claim leaves individual conditional-header
semantics to isolated live acceptance. Object streaming support does not imply
that a private database worker can receive every provider's native credentials.

Shared recovery tests exercise completion-last SHA256 readback, isolated restore,
bounded streaming, joint database/file references, controller cleanup markers
and retention of exact owned keys. Hourly health checks read committed manifests
and object inventories; they report prior restore proof and matching retained revisions,
not a fresh full-byte audit. Partial executions never certify health or count
toward the seven complete sets required before retention deletion.

### Recovery quality audit after PR #242

The audit compared the changes since `v0.1.35` through `f4ccec4` with the shared
contracts and their implemented consumers. Registry matrices cover all eight
database, seven hosting and four storage providers; unsupported rows stay
explicit. This is bounded review of recovery, adjacent rollout authority and
helper publication, not certification of every API operation in the repository.

| Boundary | Executed counterexample and enforcement |
| --- | --- |
| Cloud SQL emitted drill | Rejected/uncertain clone, failed or unrelated operation, wrong instance identity, HTTP 200 null after deletion, and provider/credential error leakage. The generated script requires correlated terminal creation before unlabeled cleanup and emits value-free diagnostics. |
| Retained SQL and object bytes | Same-size replacement after read-back or before health/retention. Real PostgreSQL restore tests and real S3 SDK serialization bind format-2 proof to the verified native revision; final deletion inventory must still match it. |
| Storage inventory | Missing object names/sizes and malformed or repeated pagination fail as unknown through real S3/Azure SDK transports and the GCS JSON API path. No object silently disappears or becomes zero bytes. |
| Private helper admission | Public immutable GHCR helper without private credentials; Railway hosting with a non-Railway database; changed or ambiguous destination; missing explicit provider cleanup proof. Shared admission checks the supported pair and current desired selection before execution. |
| Evidence upgrade | Current-contract legacy proof remains unknown. Historical contracts remain retained without blocking a fresh current set or granting deletion authority. |

These regressions were observed failing before their fixes and run under normal
`npm test`. The committed acceptance workflow and desired acceptance commands
both run that suite and type checking; live branch-protection settings were not
checked. Tests use synthetic/reconstructed responses, actual SDK serialization,
and isolated local PostgreSQL, not recorded successful provider recovery runs.
Live permissions, private routing, Railway conditional-storage semantics and a
real Cloud SQL restore still require isolated provider acceptance. Retention
checks current-key absence, not physical purging of provider version/soft-delete
history.

The adjacent hosted-configuration presence review (PR #239) reran its application
and serialized Railway transport checks without finding another defect. It
checked requested-name-only projection, repository/revision provenance, exact
bound service scope, query-only requests and secret redaction against the pinned
schema and [Railway's variable API](https://docs.railway.com/integrations/api/manage-variables).
Presence still does not establish runtime use or credential validity.

Each provider directory contains `source.json`: official source URL, upstream
revision when available, source-content SHA-256, checked-in schema SHA-256,
API version, and the exact extraction boundary. Tests verify the local hash.
Upstream descriptions/license metadata retained in OpenAPI assets belong to
their respective providers; these assets are reference contracts, not Hypervibe
API definitions.

| Contract | Pinned source | Executed coverage |
| --- | --- | --- |
| Railway | Full schema from official CLI commit `f60f3a77b980c47f1136909fbd9a443e29a2b95f` | Static adapter query validation; real `graphql-request` serialization, GraphQL input coercion and response execution; project/environment creation; unsuffixed staging web/PostgreSQL/Redis beside production; isolated second-environment bucket creation through shared plan/apply, scoped deletion and noop replan; variables, domains, volumes, delete/retry, pagination, unknown reads and uncertain writes |
| Supabase v1 | Official OpenAPI commit `26585dd4a4d6db8910a595214c9f6e8fdd206768` | Organization response and project-create request validation through the adapter's HTTP transport; ID/slug distinction; negative project-response fixture validation |
| Neon v2 | Official release OpenAPI snapshot, content hash in `source.json` | Real serialized project-create body/query validation; organization scope; negative input validation |
| SendGrid v3 webhooks | Official OpenAPI commit `fb95a935c87b79f7f982ac34bd37adab1f697dbc` (selected operations) | Event Webhook exact-ID settings reads, signing PATCH serialization and unique URL discovery; Inbound Parse exact-hostname reads/PATCH requests, exact-ID policy reads, missing/null evidence and canonical P-256 key validation; shared signing/key lifecycle uses reconstructed transport and synthetic hosting observations |
| SendGrid v3 Email Logs | Exact `tsg_logs_v3.json` at the same official commit, pinned separately as `sendgrid/email-logs.openapi.json` | Full event-name union through the real adapter, safe search/timeline projection, strict account scope, request/body budgets and value-free failure metadata; see [Email Logs](sendgrid-email-logs.md). Separate bounded live account search and same-ID detail succeeded; this does not validate complete response schemas or certify other scopes/accounts. |

Railway SDL is the complete lexicographically sorted official introspection
schema rendered without descriptions. No fields, arguments, defaults, types,
or deprecations were changed. REST snapshots contain the exact selected
operations and the transitive closure of their component references, including
response schemas. No requiredness or field types were rewritten.

Pinning a test schema does **not** freeze a hosted API. Railway `/graphql/v2`
does not select the historical CLI schema revision. Supabase `/v1` and Neon
`/v2` select major API versions, not immutable server builds. In particular,
Neon's release schema URL is mutable; tests consume only its checked-in snapshot.

## Evidence boundary

### iOS build credential environments

The shared desired-state field `ios.release.build.credentialsEnvironment`
separates build credential scope from logical release identity. The affected CI
registry contains the following named providers; native capabilities do not
imply implemented Hypervibe support:

| CI provider | Native contract and prerequisites | Hypervibe boundary |
| --- | --- | --- |
| `github-actions` | An existing repository environment has a durable numeric ID and case-insensitive name. [Jobs without deployments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/control-deployments#using-environments-without-deployments) can access its secrets while retaining reviewers, wait timers and branch restrictions; custom protection-app rules are incompatible. Reads require environment/secret metadata access. | Alternate build environment implemented for the existing managed iOS path. Exact identity, complete required-key presence and enabled custom rules are observed before publication and rechecked at apply. Unknown state or identity replacement blocks; no source writes, secret retrieval or recovery by same-name recreation. Offline contract coverage only. |
| `gitlab-ci` | [Environment-scoped variables](https://docs.gitlab.com/ci/environments/#limit-the-environment-scope-of-a-cicd-variable) use exact or wildcard scope matching. These variables are not a GitHub environment identity/protection contract. | Managed iOS releases and this selector are unsupported; the registered lifecycle explicitly rejects this CI combination before workflow generation. No GitLab adapter or live compatibility is claimed. |

`github/build-credentials/` pins the official environment, environment-secret
and enabled protection-rule endpoints. The real adapter's reconstructed HTTP
fixtures cover identity, complete bounded pagination, missing fields, API
failures, encoded paths and identity replacement during observation. Lifecycle
tests exercise real planning/apply and serialized source observation before
mocked publication/destination writes. Emitted workflow/source-contract tests
check isolated job scopes and credential-source fingerprinting. The provider
roster check keeps future CI registrations visible in ordinary `npm test`.
GitHub [secret references are case-insensitive](https://docs.github.com/en/actions/reference/security/secrets).
Schema-to-renderer regressions therefore reject lower/mixed-case reserved App
Store and managed Match names while preserving project-owned signing inputs.

The counterexample to assuming the logical release environment owns every build
credential is a staging app whose three Match keys exist only in production.
Referencing an unverified source is also unsafe: GitHub can create a missing
named environment automatically, without the intended secrets or protections.
Tests were observed failing before implementation. No live GitHub job, signing,
Apple upload or source protection enforcement was exercised. Key presence does
not establish credential validity; plan/apply observations are not atomic with
each other or with later job execution.

### Current-attempt release evidence

The iOS workflow gates and App Store submission share `templates/ios/release-attempt.cjs`.
Their reconstructed GitHub evidence follows the official
[OpenAPI at `755ee33b4a81d51f6f07a902cce26cbec3b822f2`](https://github.com/github/rest-api-description/blob/755ee33b4a81d51f6f07a902cce26cbec3b822f2/descriptions/api.github.com/api.github.com.json)
and [attempt-scoped jobs API](https://docs.github.com/en/rest/actions/workflow-jobs#list-jobs-for-a-workflow-run-attempt).
`run_started_at` resets on rerun; it and `run_attempt` are optional upstream,
so omission cannot authorize release. Artifact creation time is nullable and
does not carry an attempt ID; fresh `updated_at` cannot rescue an old artifact.
The exact attempt endpoint permits omitted `job.run_attempt`, while a supplied
contradictory attempt is rejected. Tests execute the emitted gates, the real
GitHub adapter over serialized HTTP, and ordinary MCP submission. Listings over
100 jobs or incomplete pages block instead of assuming completeness. This is
GitHub-specific existing iOS release behavior, not a new cross-provider capability.
The attempt-job transport fixtures are checked against the pinned endpoint and
response-schema subset under `github/`; generated-gate and MCP fixtures are
reconstructed, not live recordings. Timestamp correlation and final
re-observation do not make provider reads atomic.
The unchanged job schema marks `conclusion` nullable but omits null from its
enum. The contract test records that mismatch separately from schema-valid
fixtures and preserves unfinished/null responses for fail-closed authorization.

The Railway fixture executes requests against the official schema in memory;
only `fetch` is intercepted. It is synthetic state, not a captured server.
The missing-service-instance error reconstructs the message, extension code,
and field path observed in Hypervibe run
`c8ac543a-c31e-4c86-8fde-956c5fd676ee`; it is explicitly not a raw HTTP recording.
Non-null fields cannot become successful null responses through this fixture.
Deletion uses scoped tombstones. Other synthetic `NOT_FOUND` classification
unit tests do not establish that Railway emits that code for every resource.

Delayed bucket tests use a fake clock at the HTTP boundary and exercise both
same-apply convergence and timeout -> persisted recovery -> re-plan -> finalization
without a second create or import. Bucket configuration may omit mutation flags,
following the official CLI's optional
[`BucketInstance` model](https://github.com/railwayapp/cli/blob/f60f3a77b980c47f1136909fbd9a443e29a2b95f/src/controllers/config/environment.rs)
and active-instance selection in
[`bucket.rs`](https://github.com/railwayapp/cli/blob/f60f3a77b980c47f1136909fbd9a443e29a2b95f/src/commands/bucket.rs).
These timings and payloads are synthetic, not captured live responses. The
GraphQL schema treats `EnvironmentConfig` as an opaque scalar; it does not
validate those JSON internals. Exact scope, region, instance reads, unchanged
production and mutation counts therefore also have behavioral assertions.

REST tests intercept only HTTP transport and inspect the actual serialized
body. Creation receives a deliberate HTTP 400 after inspection: these tests
do not claim a successful database connection or full REST lifecycle. OpenAPI
validation checks referenced shapes, required fields, types, enums, bounds and
patterns; it does not enforce string formats or every vendor semantic rule.
Neon's optional `org_id` additionally has a semantic assertion preserving the
configured organization; schema validity alone cannot prove correct ownership.

The pinned SendGrid `ParseSetting` schema does not declare `security_policy`,
so successful schema validation does not constrain that field. Its string policy
association is sourced independently from the official
[Inbound Parse security guide](https://www.twilio.com/docs/sendgrid/for-developers/parsing-email/securing-your-parse-webhooks).
Tests assert the exact policy ID in the real client's serialized PATCH and
response interpretation. Missing association evidence remains unknown; null or
empty association values are not treated as documented detach operations.
The guide does not establish how to remove a policy or how omission proves
absence. This coverage reads existing signed policies and preserves their
association; it does not establish safe creation, disabling, deletion, or live
application signature validation. OAuth details are excluded from the adapter's
returned evidence, and public-key checks additionally validate canonical
P-256 SubjectPublicKeyInfo rather than relying on a schema string type.

Existing hand-mocked unit tests, generated CI requests, and providers not in
the table are not thereby schema-certified. Generated workflow execution and
shared lifecycle parity tests remain complementary gates. No provider is
promoted to `supported` by these offline tests.

Railway checkpoint tests also execute snapshot creation, inventory and workflow
status through the real serialized client and pinned SDL. Snapshot identities
and nullable fields follow the official CLI's
[`database/pitr.rs`](https://github.com/railwayapp/cli/blob/f60f3a77b980c47f1136909fbd9a443e29a2b95f/src/commands/database/pitr.rs#L1308-L1437),
including its explicit distinction between a volume id and a volume-instance id.
The fixture is synthetic; no backup or restore has been performed by these tests.
Checkpoint failure diagnostics also follow that revision's
[`client.rs`](https://github.com/railwayapp/cli/blob/f60f3a77b980c47f1136909fbd9a443e29a2b95f/src/client.rs)
authorization-error recognition and
[`workflow.rs`](https://github.com/railwayapp/cli/blob/f60f3a77b980c47f1136909fbd9a443e29a2b95f/src/controllers/workflow.rs)
status-polling limitations. Error fixtures are reconstructed; they verify safe
categories and retained recovery identities, not the cause of a live failure.

S3, GCS and Azure Blob Storage also run the shared storage plan/apply/binding
path with two environments using the same logical resource name. Their
stateful transport/SDK fixtures check isolated physical identities and noop
replanning; they are synthetic lifecycle tests, not pinned-schema or live API
certification. Railway runs that shared path against the schema-executed
fixture above, preserving the populated production bucket instance.

The resource-name unit contract checks native plain names, scope isolation,
lossy normalization, truncation, reserved prefixes, and minimum lengths.
Hosting transport tests assert the names actually sent on creation while
retaining historical-name fixtures for bound updates and read-only discovery.
The Pub/Sub queue test composes real adapter HTTP requests with shared plan,
apply, persisted bindings, runtime variables, noop and staging-only teardown
inside one synthetic GCP project. Legacy topic/subscription IDs remain bound;
unbound legacy resources and unknown reads block creation. These additional
tests do not expand the pinned-schema certification table above.

## Changing an integration

Cloud Billing bootstrap regressions execute the real `GcpBootstrapClient`
through reconstructed HTTP responses and the shared bootstrap preview. Evidence
is Google's [BillingAccount](https://docs.cloud.google.com/billing/docs/reference/rest/v1/billingAccounts)
and [ProjectBillingInfo](https://docs.cloud.google.com/billing/docs/reference/rest/v1/ProjectBillingInfo)
references (both last updated 2025-05-14), the
[official proto3 definitions](https://github.com/googleapis/googleapis/blob/master/google/cloud/billing/v1/cloud_billing.proto),
and [ProtoJSON default/null semantics](https://protobuf.dev/programming-guides/json/#presence-and-default-values)
(reviewed 2026-10-05). These are documentation-based assertions, not a pinned
schema validator or captured live responses. Omitted/null implicit scalars
normalize to false/empty; an empty parent denotes a non-subaccount. Malformed
explicit values and missing/mismatched resource identities still reject.
Pagination filters closed accounts, preview makes no cloud writes or connection
changes, confirmation cannot select a closed account, and billing-update polling tolerates disabled
defaults without accepting them as successful write acknowledgement. These
regressions run under ordinary `npm test`; they establish a contract defect,
not which field caused a particular live validation error or live GCP readiness.

Retained service-volume tests additionally exercise Fly, ECS Express/EFS,
Azure Container Apps/classic Azure Files, and Cloud Run/Filestore through real
clients with synthetic HTTP/SDK transport. Their fixtures cite official API
documentation; unlike Railway, they do not execute a pinned provider schema.
Shared SQLite lifecycle tests cover per-component intent, acknowledged identity,
confirmation, delayed/unknown observations and mutation-free convergence. Fly
also exercises app → disk → first Machine through the real plan/apply boundary.
Generated GitHub and portable deployment scripts are executed to check mount
preservation and reject provider-observed configuration loss. These checks do
not prove live permissions, networking, filesystem I/O, regional availability,
durability or billing. See [service volumes](../../docs/service-volumes.md).

1. State the assumption, independent evidence and counterexample before changing
   runtime code. Reproduce it as a failing test through the real client/transport.
   A fixture copied from our types, implementation or submitted request is not
   independent API evidence. Record the source and observed failing/passing
   results in the PR template's assumption section; distinguish a reproduced bug
   from a proven customer-incident cause.
2. Validate positive requests **and** responses against the pinned official
   contract. Check its validation boundary: opaque JSON/scalars require separate
   evidence for nested fields and semantics. Exercise valid omitted/null/defaulted
   fields where permitted; keep malformed fixtures in named negative tests. Add
   semantic assertions for durable identity, environment isolation and mutation
   count. Keep these regressions in the ordinary `npm test` acceptance gate.
3. For lifecycle changes include a populated first environment, a second
   environment, pagination, bound/unbound retries, failed observations and
   ambiguous mutation outcomes. Unbound resources require explicit adoption;
   an unknown read is never absence.
   For naming changes also exercise normalization/length collisions, retained
   old names and uncertain-write markers, runtime/CI binding consumers, noop
   mutation counts and teardown. Update every affected provider's contract;
   do not declare a shared naming cleanup complete from one adapter's test.
4. Update a schema only in an explicit reviewed PR. Fetch the official URL in
   `source.json`, record the new immutable revision where offered, and hash the
   exact downloaded bytes. Reapply the documented transformation, review the
   API diff, update the local hash, and run the contract and affected lifecycle
   suites. Never fetch “latest” from a test or scheduled contract job, or change
   a pinned schema merely to make an invented request pass.
5. Run opt-in live acceptance through normal Hypervibe spec/plan/apply with
   isolated resources and explicit billing/destruction authority. Preserve
   failed-resource bindings for recovery. Record the tested source SHA,
   provider/API version, exact scoped identities, operation results, terminal
   health/absence, and sanitized evidence. Never commit tokens, passwords,
   connection strings, dotenv values or raw unredacted response bodies.

For the Apreskeys recovery, live acceptance must prove staging resources and
bindings beside unchanged production, exact-reviewed-SHA managed deployment,
public health, and a subsequent noop plan. Customer production is not a
destructive test fixture. Broader create/update/delete live certification stays
in disposable accounts; the existing live harness's project/environment cleanup
TODO remains a limitation, not a passing check.

Connect Cloud scope preparation additionally runs
`gcp-project-installation.test.ts` and `gcp-billing-installation.test.ts` in the
ordinary Vitest gate. These use reconstructed Resource Manager/Billing REST
responses, not captured live acceptance. Project creation has an independently
reviewed continuation; existing billing verification is mutation-free. New
billing attachment remains hard blocked: inherited unlink permission on another
account invalidates a selected-account-only preservation argument. Cleanup tests
reconstruct historical native resources and exact durable attempts, then exercise
read-only recovery and explicit removal through the actual shared engine. The
fixture's synthetic historical plan is not a runtime feature flag or a production
bypass. See [scope evidence and remaining gaps](../../docs/connect-cloud-scope-preparation.md).
